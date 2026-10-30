import 'server-only';
import { randomUUID } from 'node:crypto';
import { findService } from './catalog';
import { withBookingLock } from './locks';
import { defaultStaffFor, findStaff } from './staff';
import type { Booking, BookingStore } from './store';

/**
 * A PayPal authorization is reliably capturable for 3 days (the "honor period"), so deposit-backed
 * bookings are limited to that window. Later bookings need a saved wallet (Vault, PLAN P1 item 11).
 */
export const MAX_DAYS_AHEAD = 3;

export class BookingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookingInputError';
  }
}

export interface NewBookingInput {
  serviceId: unknown;
  customerName: unknown;
  startsAt: unknown;
}

export function createBooking(
  store: BookingStore,
  input: NewBookingInput,
  now: Date = new Date(),
): Booking {
  if (typeof input.serviceId !== 'string') throw new BookingInputError('serviceId is required.');
  const service = findService(input.serviceId);
  if (!service) throw new BookingInputError(`Unknown service "${input.serviceId}".`);

  const customerName = typeof input.customerName === 'string' ? input.customerName.trim() : '';
  if (customerName.length === 0 || customerName.length > 80) {
    throw new BookingInputError('customerName must be 1-80 characters.');
  }
  // Control characters and half a surrogate pair are never a name, and Postgres can't store them.
  if (/[\u0000-\u001f\u007f]|[\uD800-\uDFFF]/u.test(customerName)) {
    throw new BookingInputError('customerName contains characters that are not allowed.');
  }

  if (typeof input.startsAt !== 'string') throw new BookingInputError('startsAt is required.');
  const startsAtMs = Date.parse(input.startsAt);
  if (Number.isNaN(startsAtMs)) {
    throw new BookingInputError('startsAt must be an ISO 8601 date-time.');
  }
  if (startsAtMs <= now.getTime()) throw new BookingInputError('startsAt must be in the future.');
  if (startsAtMs > now.getTime() + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000) {
    throw new BookingInputError(
      `Deposit-backed bookings can be at most ${MAX_DAYS_AHEAD} days ahead.`,
    );
  }

  const booking: Booking = {
    id: randomUUID(),
    serviceId: service.id,
    customerName,
    startsAt: new Date(startsAtMs).toISOString(),
    deposit: { ...service.deposit },
    status: 'awaiting_deposit',
    createdAt: now.toISOString(),
    staffId: defaultStaffFor(service.id)?.id,
  };
  store.save(booking);
  return booking;
}

/** Bookings that already happened or were closed can't be moved. */
const MOVABLE = new Set(['awaiting_deposit', 'deposit_held', 'deposit_pending', 'deposit_needs_review']);

const HONOR_PERIOD_MS = MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000;

/**
 * Why a booking can't be moved to `startsAt`, or undefined if it can. Shared by moveBooking and the
 * copilot's plan check, so a bad move is caught while the plan is made, not after approval.
 * A held deposit is reliably capturable for 3 days from when it was authorized (PayPal's honor
 * period; reauthorize to renew it), so a held booking can't move past that or past the hold's expiry.
 */
export function moveTimeProblem(booking: Booking, startsAt: string, now: Date): string | undefined {
  const ms = Date.parse(startsAt);
  if (Number.isNaN(ms)) return 'startsAt must be an ISO 8601 date-time.';
  if (ms <= now.getTime()) return 'startsAt must be in the future.';
  if (ms > now.getTime() + HONOR_PERIOD_MS) return `Deposit-backed bookings can be at most ${MAX_DAYS_AHEAD} days ahead.`;
  const hold = booking.hold;
  if (hold?.heldAt && ms > Date.parse(hold.heldAt) + HONOR_PERIOD_MS) {
    return 'That time is more than 3 days after the deposit was authorized, when PayPal may no longer capture it. Keep the booking within that window, or move it later once the hold has been reauthorized.';
  }
  if (hold?.expiresAt && ms > Date.parse(hold.expiresAt)) {
    return 'That time is after the PayPal hold expires; the deposit could not be captured.';
  }
  return undefined;
}

/**
 * Moves a booking to another staff member and/or time (owner copilot step; no money moves). Time
 * rules are in moveTimeProblem.
 */
export function moveBooking(
  store: BookingStore,
  bookingId: string,
  change: { staffId?: string; startsAt?: string },
  now: Date = new Date(),
): Promise<Booking> {
  return withBookingLock(bookingId, async () => {
    const booking = store.get(bookingId);
    if (!booking) throw new BookingInputError(`Booking ${bookingId} not found.`);
    if (!MOVABLE.has(booking.status)) {
      throw new BookingInputError(`Booking ${bookingId} is "${booking.status}" and can't be moved.`);
    }
    if (change.staffId === undefined && change.startsAt === undefined) {
      throw new BookingInputError('Nothing to change: give staffId and/or startsAt.');
    }
    if (change.staffId !== undefined && !findStaff(change.staffId)) {
      throw new BookingInputError(`Unknown staff member "${change.staffId}".`);
    }
    let startsAt = booking.startsAt;
    if (change.startsAt !== undefined) {
      const problem = moveTimeProblem(booking, change.startsAt, now);
      if (problem) throw new BookingInputError(problem);
      startsAt = new Date(Date.parse(change.startsAt)).toISOString();
    }
    const moved: Booking = { ...booking, startsAt, staffId: change.staffId ?? booking.staffId };
    store.save(moved);
    return moved;
  });
}
