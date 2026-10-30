import { describe, expect, it } from 'vitest';
import { createBooking, moveBooking } from '@/lib/booking/bookings';
import { createMemoryBookingStore, type Booking, type BookingStore } from '@/lib/booking/store';

// Fixed clock: tests never depend on the real date.
const NOW = new Date('2026-11-01T09:00:00.000Z');

function held(store: BookingStore, hold: Partial<NonNullable<Booking['hold']>> = {}, status: Booking['status'] = 'deposit_held') {
  const b = createBooking(store, { serviceId: 'haircut', customerName: 'Ana', startsAt: '2026-11-02T10:00:00.000Z' }, NOW);
  const booking: Booking = {
    ...b,
    status,
    hold: {
      paypalOrderId: 'O-1',
      orderAttempt: 1,
      orderCreatedAt: NOW.toISOString(),
      authorizationId: 'AUTH-1',
      heldAt: NOW.toISOString(),
      expiresAt: '2026-11-30T00:00:00Z',
      ...hold,
    },
  };
  store.save(booking);
  return booking;
}

describe('moveBooking', () => {
  it('moves the time and/or staff member', async () => {
    const store = createMemoryBookingStore();
    const b = held(store);
    const moved = await moveBooking(store, b.id, { staffId: 'ken', startsAt: '2026-11-03T15:30:00+08:00' }, NOW);
    expect(moved).toMatchObject({ staffId: 'ken', startsAt: '2026-11-03T07:30:00.000Z', status: 'deposit_held' });
    expect(store.get(b.id)).toMatchObject({ staffId: 'ken', startsAt: '2026-11-03T07:30:00.000Z' });
  });

  it.each([
    ['in the past', '2026-11-01T08:00:00.000Z', 'in the future'],
    ['more than 3 days ahead', '2026-11-04T10:00:00.000Z', 'at most 3 days ahead'],
    ['not a date', 'tomorrow', 'ISO 8601'],
  ])('refuses a time %s', async (_label, startsAt, message) => {
    const store = createMemoryBookingStore();
    const b = held(store);
    await expect(moveBooking(store, b.id, { startsAt }, NOW)).rejects.toThrow(message);
    expect(store.get(b.id)!.startsAt).toBe('2026-11-02T10:00:00.000Z');
  });

  it('refuses a time past the honor period of a hold authorized earlier (R3)', async () => {
    const store = createMemoryBookingStore();
    // Authorized two days ago: the honor period ends tomorrow at 09:00.
    const b = held(store, { heldAt: '2026-10-30T09:00:00.000Z' });
    await expect(moveBooking(store, b.id, { startsAt: '2026-11-02T12:00:00.000Z' }, NOW)).rejects.toThrow('reauthorize');
  });

  it('refuses a time after the hold expires', async () => {
    const store = createMemoryBookingStore();
    const b = held(store, { expiresAt: '2026-11-02T00:00:00Z' });
    await expect(moveBooking(store, b.id, { startsAt: '2026-11-02T10:00:00.000Z' }, NOW)).rejects.toThrow('hold expires');
  });

  it.each(['cancelled', 'completed', 'no_show_charged', 'refunded'] as const)('refuses to move a %s booking', async (status) => {
    const store = createMemoryBookingStore();
    const b = held(store, {}, status);
    await expect(moveBooking(store, b.id, { staffId: 'ken' }, NOW)).rejects.toThrow("can't be moved");
  });

  it('refuses unknown staff, an empty change and an unknown booking', async () => {
    const store = createMemoryBookingStore();
    const b = held(store);
    await expect(moveBooking(store, b.id, { staffId: 'bob' }, NOW)).rejects.toThrow('Unknown staff');
    await expect(moveBooking(store, b.id, {}, NOW)).rejects.toThrow('Nothing to change');
    await expect(moveBooking(store, 'nope', { staffId: 'ken' }, NOW)).rejects.toThrow('not found');
  });
});
