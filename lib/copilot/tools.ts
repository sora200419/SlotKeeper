import 'server-only';
import type Anthropic from '@anthropic-ai/sdk';
import { findService } from '@/lib/booking/catalog';
import { businessDay, dailyEarnings } from '@/lib/booking/earnings';
import { defaultStaffFor, listStaff } from '@/lib/booking/staff';
import type { Booking, BookingStore } from '@/lib/booking/store';
import { refundedCents } from '@/lib/paypal/deposit-actions';

/** Read-only view of a booking for the model: no vault or PayPal customer ids. */
function view(booking: Booking) {
  const hold = booking.hold;
  return {
    id: booking.id,
    service: findService(booking.serviceId)?.name ?? booking.serviceId,
    serviceId: booking.serviceId,
    customerName: booking.customerName,
    startsAt: booking.startsAt,
    staffId: booking.staffId ?? defaultStaffFor(booking.serviceId)?.id ?? null,
    status: booking.status,
    depositCents: booking.deposit.cents,
    holdExpiresAt: hold?.expiresAt ?? null,
    capturedCents: hold?.capture?.amountCents ?? 0,
    refundedCents: hold ? refundedCents(hold) : 0,
    savedWallet: hold?.savedWallet?.status === 'VAULTED',
    walletChargedCents: (hold?.walletCharges ?? []).reduce((sum, c) => sum + c.amountCents, 0),
    moneyActionPending: hold?.pendingAction?.kind ?? null,
  };
}

const STEP_SCHEMA = {
  type: 'object',
  description:
    'One step. type decides which other fields apply: move_booking (bookingId, staffId and/or startsAt), ' +
    'capture_deposit (bookingId, reason, optional amountCents for a no-show fee), void_deposit (bookingId), ' +
    'reauthorize_deposit (bookingId), refund_deposit (bookingId, optional amountCents), ' +
    'charge_saved_wallet (bookingId, optional amountCents), run_payouts (day).',
  properties: {
    type: {
      type: 'string',
      enum: [
        'move_booking',
        'capture_deposit',
        'void_deposit',
        'reauthorize_deposit',
        'refund_deposit',
        'charge_saved_wallet',
        'run_payouts',
      ],
    },
    bookingId: { type: 'string' },
    staffId: { type: 'string', description: 'move_booking: the new staff member (from list_staff).' },
    startsAt: { type: 'string', description: 'move_booking: the new start time, ISO 8601 UTC.' },
    reason: { type: 'string', enum: ['completed', 'no_show'], description: 'capture_deposit only.' },
    amountCents: { type: 'integer', minimum: 1, description: 'Whole US cents. Omit for the default (full) amount.' },
    day: { type: 'string', description: 'run_payouts: business day YYYY-MM-DD that is already over.' },
    why: { type: 'string', description: 'One sentence the owner will read: why this step.' },
  },
  required: ['type', 'why'],
  additionalProperties: false,
} as const;

export const COPILOT_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'list_bookings',
    description:
      'List bookings with their money state (deposit, captured, refunded, saved wallet). Optional filters. ' +
      'Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        staffId: { type: 'string', description: 'Only bookings assigned to this staff member.' },
        day: { type: 'string', description: 'Only bookings starting on this business day (YYYY-MM-DD).' },
        status: { type: 'string', description: 'Only bookings with this status, e.g. deposit_held.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_booking',
    description: 'One booking with its money state. Read-only.',
    input_schema: {
      type: 'object',
      properties: { bookingId: { type: 'string' } },
      required: ['bookingId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_staff',
    description: 'Staff members, the services they do by default, and their commission rate. Read-only.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'daily_earnings',
    description: 'Each staff member\'s commission and tips for one business day (what a payout would send). Read-only.',
    input_schema: {
      type: 'object',
      properties: { day: { type: 'string', description: 'YYYY-MM-DD in the business time zone.' } },
      required: ['day'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_plan',
    description:
      'Submit the plan for the owner to approve. Nothing runs until they approve it; then the steps run in ' +
      'order and stop at the first failure. Call this once, at the end, whenever the owner asked for any ' +
      'change. Money steps use PayPal: capture takes the held deposit (in full for a completed visit, or a ' +
      'no-show fee), void releases a hold at no cost (prefer it over refund when nothing was captured), ' +
      'reauthorize renews a hold older than 3 days, refund returns captured money, charge_saved_wallet ' +
      'charges a customer who saved their PayPal after their hold is finished, run_payouts pays staff for a ' +
      'finished day.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Two or three sentences for the owner: what changes and what money moves.' },
        steps: { type: 'array', items: STEP_SCHEMA, minItems: 1, maxItems: 50 },
      },
      required: ['summary', 'steps'],
      additionalProperties: false,
    },
  },
];

export interface ToolContext {
  bookings: BookingStore;
  timeZone: string;
}

/** Runs a read-only tool. Returns JSON text for the tool_result. */
export function runReadTool(name: string, input: Record<string, unknown>, ctx: ToolContext): string {
  switch (name) {
    case 'list_bookings': {
      const rows = ctx.bookings
        .list()
        .map(view)
        .filter((b) => (typeof input.staffId === 'string' ? b.staffId === input.staffId : true))
        .filter((b) => (typeof input.status === 'string' ? b.status === input.status : true))
        .filter((b) => (typeof input.day === 'string' ? businessDay(b.startsAt, ctx.timeZone) === input.day : true))
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      return JSON.stringify({ bookings: rows.slice(0, 200), total: rows.length });
    }
    case 'get_booking': {
      const booking = typeof input.bookingId === 'string' ? ctx.bookings.get(input.bookingId) : undefined;
      return JSON.stringify(booking ? view(booking) : { error: 'booking not found' });
    }
    case 'list_staff':
      return JSON.stringify({
        staff: listStaff().map((s) => ({ id: s.id, name: s.name, services: s.services, commissionPercent: s.commissionBps / 100 })),
      });
    case 'daily_earnings':
      if (typeof input.day !== 'string') return JSON.stringify({ error: 'day is required' });
      return JSON.stringify({ day: input.day, timeZone: ctx.timeZone, earnings: dailyEarnings(ctx.bookings.list(), input.day, ctx.timeZone) });
    default:
      return JSON.stringify({ error: `unknown tool ${name}` });
  }
}
