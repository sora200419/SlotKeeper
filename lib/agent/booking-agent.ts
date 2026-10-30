import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { blocks, freeStaffFor, searchSlots, slotConflict, UNPAID_HOLD_MS, type Slot } from '@/lib/booking/availability';
import { BookingInputError, createBooking } from '@/lib/booking/bookings';
import { findService, formatAmount, listServices } from '@/lib/booking/catalog';
import { withBookingLock } from '@/lib/booking/locks';
import type { Booking, BookingStore } from '@/lib/booking/store';
import { voidDeposit, type DepositPayments } from '@/lib/paypal/deposit-actions';
import { createDepositOrder, type DepositOrders, type ReturnUrls } from '@/lib/paypal/deposits';

/** A refusal the customer's assistant can act on (shown to it as a tool error). */
export class AgentError extends Error {
  constructor(
    readonly code: 'not_found' | 'forbidden' | 'slot_taken' | 'not_cancellable' | 'try_later' | 'rate_limited' | 'expired',
    message: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

const hash = (token: string) => createHash('sha256').update(token).digest();

/** Unpaid AI-made reservations allowed at once, across all clients. */
export const MAX_UNPAID_AGENT_HOLDS = 30;
/** An unpaid reservation's claim, renewals included, never outlives this (two 30-minute claims). */
export const MAX_UNPAID_CLAIM_MS = 2 * UNPAID_HOLD_MS;

/** The booking, if `token` is the one handed out for it. Same answer for "no such booking" and "wrong token". */
function authorized(store: BookingStore, bookingId: string, token: string): Booking {
  const booking = store.get(bookingId);
  const expected = booking?.accessTokenHash ? Buffer.from(booking.accessTokenHash, 'hex') : undefined;
  if (!booking || !expected || expected.length !== 32 || !timingSafeEqual(hash(token), expected)) {
    throw new AgentError('forbidden', 'Unknown booking or wrong booking token.');
  }
  return booking;
}

export function listBookableServices() {
  return listServices().map((s) => ({
    serviceId: s.id,
    name: s.name,
    durationMinutes: s.durationMinutes,
    price: `${formatAmount(s.price)} ${s.price.currency}`,
    deposit: `${formatAmount(s.deposit)} ${s.deposit.currency}`,
  }));
}

export function findSlots(store: BookingStore, serviceId: string, day: string, timeZone: string, now: Date): Slot[] {
  if (!findService(serviceId)) throw new BookingInputError(`Unknown service "${serviceId}".`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new BookingInputError('day must look like 2026-11-01.');
  return searchSlots(store.list(), serviceId, day, timeZone, now);
}

/**
 * Reserves a free slot for a customer: creates the booking (awaiting its deposit) with the staff
 * member who is free then, and returns a booking token that the assistant must present for every
 * later call. Slot checks and creation run under one lock so two assistants can't take the same slot.
 * An unpaid booking stops blocking its slot after 30 minutes.
 */
export function holdSlot(
  store: BookingStore,
  input: { serviceId: string; startsAt: string; customerName: string },
  timeZone: string,
  now: Date = new Date(),
  client: { key: string; limiter?: { take(key: string, now: number): boolean } } = { key: 'unknown' },
): Promise<{ booking: Booking; bookingToken: string }> {
  return withBookingLock(
    'slots',
    async () => {
      if (!findService(input.serviceId)) throw new BookingInputError(`Unknown service "${input.serviceId}".`);
      // The endpoint is public: cap unpaid reservations so nobody can block the whole calendar.
      const unpaidAgentHolds = store.list().filter((b) => b.source === 'agent' && b.status === 'awaiting_deposit' && blocks(b, now));
      if (unpaidAgentHolds.length >= MAX_UNPAID_AGENT_HOLDS) {
        throw new AgentError('rate_limited', 'Too many unpaid reservations right now; please try again later.');
      }
      if (client.limiter && !client.limiter.take(client.key, now.getTime())) {
        throw new AgentError('rate_limited', 'Too many reservations from this client; please wait a few minutes.');
      }
      const staffId = freeStaffFor(store, input.serviceId, input.startsAt, timeZone, now);
      if (!staffId) {
        throw new AgentError('slot_taken', 'That time is not available. Call search_slots for free times.');
      }
      const created = createBooking(store, input, now);
      const bookingToken = randomBytes(24).toString('base64url');
      const booking: Booking = { ...created, staffId, source: 'agent', accessTokenHash: hash(bookingToken).toString('hex') };
      store.save(booking);
      return { booking, bookingToken };
    },
    'wait',
  );
}

/**
 * Starts the deposit (prompt 2's order flow, optionally saving the wallet as in prompt 5) and returns
 * PayPal's approval link for the customer to open. Once they approve, the CHECKOUT.ORDER.APPROVED
 * webhook places the hold; booking_status shows when it is held.
 */
export async function startDeposit(
  orders: () => DepositOrders,
  store: BookingStore,
  input: { bookingId: string; bookingToken: string; savePayment?: boolean },
  urls: ReturnUrls,
  now: Date = new Date(),
): Promise<{ orderId: string; approveUrl?: string }> {
  authorized(store, input.bookingId, input.bookingToken);
  // An unpaid reservation that lapsed must claim its slot again before a payment link is handed out
  // (the slots lock is released before the order call, so it is never held while waiting on PayPal).
  await withBookingLock(
    'slots',
    async () => {
      const booking = store.get(input.bookingId)!;
      if (booking.status !== 'awaiting_deposit' || blocks(booking, now)) return;
      // Renewable once (a claim lasts at most an hour in total), so nobody can keep slots blocked
      // by renewing forever; after that the customer must hold_slot again, which is rate limited.
      if (now.getTime() - Date.parse(booking.createdAt) >= MAX_UNPAID_CLAIM_MS) {
        throw new AgentError('expired', 'This reservation expired without a deposit. Call search_slots and hold_slot again.');
      }
      if (slotConflict(store.list(), booking, now)) {
        throw new AgentError('slot_taken', 'This reservation lapsed and the time was taken. Call search_slots and hold_slot again.');
      }
      store.save({ ...booking, slotHeldAt: now.toISOString() });
    },
    'wait',
  );
  return createDepositOrder(orders(), store, input.bookingId, urls, now, { savePayment: input.savePayment === true });
}

/**
 * Cancels for the customer. Unpaid: just cancelled. Deposit held: released with a free void.
 * Money already taken, or a booking whose time has passed, is for the business to handle.
 */
export async function cancelForCustomer(
  /** Built only when a deposit hold must be voided (an unpaid booking needs no PayPal). */
  payments: () => DepositPayments,
  store: BookingStore,
  input: { bookingId: string; bookingToken: string },
  now: Date = new Date(),
): Promise<Booking> {
  const booking = authorized(store, input.bookingId, input.bookingToken);
  if (Date.parse(booking.startsAt) <= now.getTime()) {
    throw new AgentError('not_cancellable', 'This appointment has already started; please contact the business.');
  }
  if (booking.status === 'cancelled') return booking;
  if (booking.status === 'awaiting_deposit') {
    return withBookingLock(input.bookingId, async () => {
      const current = store.get(input.bookingId)!;
      if (current.status !== 'awaiting_deposit') {
        throw new AgentError('try_later', 'The deposit was just placed; call cancel_booking again to release it.');
      }
      if (current.hold?.authorizeOutcomeUnknown) {
        throw new AgentError('try_later', 'PayPal is still confirming the deposit; try again in a minute.');
      }
      const cancelled: Booking = { ...current, status: 'cancelled' };
      store.save(cancelled);
      return cancelled;
    });
  }
  if (!booking.hold?.capture && ['deposit_held', 'deposit_pending'].includes(booking.status)) {
    return voidDeposit(payments(), store, input.bookingId, now);
  }
  throw new AgentError('not_cancellable', `This booking is "${booking.status}"; please contact the business.`);
}

/** What the customer's assistant may know about the booking. */
export function bookingStatus(store: BookingStore, input: { bookingId: string; bookingToken: string }, now: Date = new Date()) {
  const booking = authorized(store, input.bookingId, input.bookingToken);
  const lapsed = booking.status === 'awaiting_deposit' && !blocks(booking, now);
  return {
    bookingId: booking.id,
    service: findService(booking.serviceId)?.name ?? booking.serviceId,
    startsAt: booking.startsAt,
    staffId: booking.staffId,
    status: booking.status,
    deposit: `${formatAmount(booking.deposit)} ${booking.deposit.currency}`,
    depositHeld: booking.status === 'deposit_held',
    // A lapsed reservation's old link is not shown; create_deposit re-claims the slot first.
    reservationLapsed: lapsed,
    approveUrl: booking.status === 'awaiting_deposit' && !lapsed ? booking.hold?.approveUrl : undefined,
  };
}
