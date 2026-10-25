import 'server-only';
import { randomUUID } from 'node:crypto';
import { findService } from './catalog';
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
  };
  store.save(booking);
  return booking;
}
