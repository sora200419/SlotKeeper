import 'server-only';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { depositReturnUrls } from '@/lib/api/app-origin';
import { BookingInputError } from '@/lib/booking/bookings';
import { BookingBusyError } from '@/lib/booking/locks';
import type { BookingStore } from '@/lib/booking/store';
import { PayPalConfigError } from '@/lib/paypal/config';
import type { DepositPayments } from '@/lib/paypal/deposit-actions';
import { DepositError, type DepositOrders } from '@/lib/paypal/deposits';
import { sanitizeError } from '@/lib/paypal/errors';
import {
  AgentError,
  bookingStatus,
  cancelForCustomer,
  findSlots,
  holdSlot,
  listBookableServices,
  startDeposit,
} from './booking-agent';

export interface McpDeps {
  bookings: BookingStore;
  /** Built on first use: a search doesn't need PayPal settings to be valid. */
  orders: () => DepositOrders;
  payments: () => DepositPayments;
  timeZone: string;
  /** Public origin for PayPal return links. */
  origin: string;
  /** Who is calling (client IP), for the hold_slot rate limit. */
  clientKey?: string;
  holdLimiter?: { take(key: string, now: number): boolean };
  now?: () => Date;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const ok = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

/** Expected refusals become tool errors the assistant can read; anything else is logged and kept vague. */
function failure(err: unknown, tool: string): ToolResult {
  let message: string;
  if (err instanceof AgentError || err instanceof DepositError) {
    message = `${err.code}: ${err.message}`;
    if (err instanceof DepositError && err.httpStatus >= 500) console.error('[mcp] payment step failed', { tool, code: err.code });
  }
  else if (err instanceof BookingInputError) message = `invalid_input: ${err.message}`;
  else if (err instanceof BookingBusyError) message = `try_later: ${err.message}`;
  else if (err instanceof PayPalConfigError) {
    console.error('[mcp] payments are not configured', { tool, missing: err.missing });
    message = 'unavailable: payments are not configured on this server.';
  } else {
    console.error('[mcp] tool failed', { tool, error: sanitizeError(err, tool).message });
    message = 'error: something went wrong on our side; please try again.';
  }
  return { content: [{ type: 'text', text: message }], isError: true };
}

const bookingRef = {
  bookingId: z.string().min(1).describe('The bookingId returned by hold_slot.'),
  bookingToken: z.string().min(1).describe('The bookingToken returned by hold_slot. Keep it private.'),
};

/**
 * SlotKeeper's booking tools for a customer's AI assistant (MCP). Booking and paying is split so the
 * customer stays in control of money: the assistant reserves a slot and gets a PayPal approval link;
 * the customer approves the deposit hold in PayPal themselves.
 */
export function createBookingMcpServer(deps: McpDeps): McpServer {
  const now = deps.now ?? (() => new Date());
  const server = new McpServer({ name: 'slotkeeper', version: '0.1.0' });

  server.registerTool(
    'search_slots',
    {
      title: 'Search free appointment times',
      description:
        'Free start times for a service on one day (business time zone), with the staff member. Bookings can be ' +
        'made at most 3 days ahead. Call with no serviceId to list the services, prices and deposits.',
      inputSchema: {
        serviceId: z.string().optional().describe('haircut, color or physio. Omit to list services.'),
        day: z.string().optional().describe('YYYY-MM-DD in the business time zone.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ serviceId, day }) => {
      try {
        if (!serviceId || !day) return ok({ timeZone: deps.timeZone, services: listBookableServices() });
        return ok({ timeZone: deps.timeZone, serviceId, day, slots: findSlots(deps.bookings, serviceId, day, deps.timeZone, now()) });
      } catch (err) {
        return failure(err, 'search_slots');
      }
    },
  );

  server.registerTool(
    'hold_slot',
    {
      title: 'Reserve a time',
      description:
        'Reserves a free time from search_slots for the customer. Returns a bookingId and a bookingToken: keep the ' +
        'token, it is needed for every later call. The slot is kept for 30 minutes; create_deposit renews it once ' +
        '(an hour at most), after which the reservation expires.',
      inputSchema: {
        serviceId: z.string(),
        startsAt: z.string().describe('A startsAt value from search_slots (ISO 8601).'),
        customerName: z.string().min(1).max(80),
      },
    },
    async (input) => {
      try {
        const { booking, bookingToken } = await holdSlot(deps.bookings, input, deps.timeZone, now(), {
          key: deps.clientKey ?? 'unknown',
          limiter: deps.holdLimiter,
        });
        return ok({ bookingId: booking.id, bookingToken, startsAt: booking.startsAt, staffId: booking.staffId, status: booking.status });
      } catch (err) {
        return failure(err, 'hold_slot');
      }
    },
  );

  server.registerTool(
    'create_deposit',
    {
      title: 'Start the deposit',
      description:
        'Creates the PayPal deposit for a held booking and returns approveUrl. Give the link to the customer: they ' +
        'approve the deposit hold in PayPal (nothing is charged unless they miss the appointment). With savePayment ' +
        'the customer agrees to save their PayPal for future deposits and no-show fees. Then poll booking_status.',
      inputSchema: { ...bookingRef, savePayment: z.boolean().optional() },
    },
    async (input) => {
      try {
        const result = await startDeposit(deps.orders, deps.bookings, input, depositReturnUrls(deps.origin, input.bookingId), now());
        return ok({ ...result, next: 'Ask the customer to open approveUrl and approve; then check booking_status.' });
      } catch (err) {
        return failure(err, 'create_deposit');
      }
    },
  );

  server.registerTool(
    'cancel_booking',
    {
      title: 'Cancel a booking',
      description:
        'Cancels the customer\'s booking before it starts. An unpaid booking is simply cancelled; a deposit hold ' +
        'is released in full. Money already charged must be handled by the business.',
      inputSchema: bookingRef,
      annotations: { destructiveHint: true },
    },
    async (input) => {
      try {
        const booking = await cancelForCustomer(deps.payments, deps.bookings, input, now());
        return ok({ bookingId: booking.id, status: booking.status });
      } catch (err) {
        return failure(err, 'cancel_booking');
      }
    },
  );

  server.registerTool(
    'booking_status',
    {
      title: 'Booking status',
      description: 'The booking\'s status; depositHeld becomes true once the customer approved the deposit in PayPal.',
      inputSchema: bookingRef,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        return ok(bookingStatus(deps.bookings, input, now()));
      } catch (err) {
        return failure(err, 'booking_status');
      }
    },
  );

  return server;
}
