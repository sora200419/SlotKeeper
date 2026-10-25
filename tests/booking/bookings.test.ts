import { describe, expect, it } from 'vitest';
import { BookingInputError, createBooking } from '@/lib/booking/bookings';
import { formatAmount } from '@/lib/booking/catalog';
import { createMemoryBookingStore } from '@/lib/booking/store';

// Fixed clock: tests never depend on the real date.
const NOW = new Date('2026-11-01T00:00:00.000Z');
const TOMORROW = '2026-11-02T10:00:00.000Z';

describe('formatAmount', () => {
  it('formats cents as a two-decimal string', () => {
    expect(formatAmount({ currency: 'USD', cents: 1000 })).toBe('10.00');
    expect(formatAmount({ currency: 'USD', cents: 5 })).toBe('0.05');
    expect(formatAmount({ currency: 'USD', cents: 0 })).toBe('0.00');
    expect(formatAmount({ currency: 'USD', cents: 123456 })).toBe('1234.56');
  });

  it('rejects negative or fractional cents', () => {
    expect(() => formatAmount({ currency: 'USD', cents: -1 })).toThrow();
    expect(() => formatAmount({ currency: 'USD', cents: 10.5 })).toThrow();
  });
});

describe('createBooking', () => {
  it('takes the deposit from the catalog and ignores any amount in the input', () => {
    const store = createMemoryBookingStore();
    const booking = createBooking(
      store,
      { serviceId: 'haircut', customerName: ' Ana ', startsAt: TOMORROW, deposit: 1 } as never,
      NOW,
    );
    expect(booking.deposit).toEqual({ currency: 'USD', cents: 1000 });
    expect(booking.customerName).toBe('Ana');
    expect(booking.status).toBe('awaiting_deposit');
    expect(store.get(booking.id)).toEqual(booking);
  });

  it.each([
    [{ serviceId: 'massage', customerName: 'Ana', startsAt: TOMORROW }, /Unknown service/],
    [{ serviceId: 42, customerName: 'Ana', startsAt: TOMORROW }, /serviceId/],
    [{ serviceId: 'haircut', customerName: '   ', startsAt: TOMORROW }, /customerName/],
    [{ serviceId: 'haircut', customerName: 'x'.repeat(81), startsAt: TOMORROW }, /customerName/],
    [{ serviceId: 'haircut', customerName: 'Ana', startsAt: 'next tuesday' }, /ISO 8601/],
    [{ serviceId: 'haircut', customerName: 'Ana', startsAt: '2026-10-31T10:00:00Z' }, /future/],
    [{ serviceId: 'haircut', customerName: 'Ana', startsAt: '2026-11-04T00:00:01Z' }, /3 days/],
  ])('rejects invalid input %#', (input, message) => {
    const store = createMemoryBookingStore();
    expect(() => createBooking(store, input, NOW)).toThrow(BookingInputError);
    expect(() => createBooking(store, input, NOW)).toThrow(message);
  });

  it('accepts a slot exactly 3 days ahead', () => {
    const store = createMemoryBookingStore();
    expect(() =>
      createBooking(
        store,
        { serviceId: 'physio', customerName: 'Ana', startsAt: '2026-11-04T00:00:00.000Z' },
        NOW,
      ),
    ).not.toThrow();
  });

  it('returns copies, so callers cannot mutate stored bookings', () => {
    const store = createMemoryBookingStore();
    const booking = createBooking(
      store,
      { serviceId: 'haircut', customerName: 'Ana', startsAt: TOMORROW },
      NOW,
    );
    store.get(booking.id)!.status = 'deposit_held';
    expect(store.get(booking.id)!.status).toBe('awaiting_deposit');
  });
});
