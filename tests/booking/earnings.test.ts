import { describe, expect, it } from 'vitest';
import { businessDay, dailyEarnings } from '@/lib/booking/earnings';
import { readPayoutEmails } from '@/lib/booking/staff';
import type { Booking, DepositHold } from '@/lib/booking/store';

const DAY = '2026-11-01';

function booking(id: string, serviceId: string, hold: Partial<DepositHold>, extra: Partial<Booking> = {}): Booking {
  return {
    id,
    serviceId,
    customerName: 'Ana',
    startsAt: '2026-11-01T10:00:00.000Z',
    deposit: { currency: 'USD', cents: 1000 },
    status: 'completed',
    createdAt: '2026-10-31T10:00:00.000Z',
    hold: { paypalOrderId: 'O', orderAttempt: 1, orderCreatedAt: '2026-10-31T10:00:00.000Z', ...hold },
    ...extra,
  };
}
const capture = (amountCents: number, capturedAt = `${DAY}T12:00:00.000Z`, status = 'COMPLETED') => ({
  captureId: 'CAP',
  amountCents,
  status,
  reason: 'completed' as const,
  capturedAt,
});

describe('businessDay', () => {
  it('uses the business time zone, not UTC', () => {
    expect(businessDay('2026-11-01T06:00:00.000Z', 'UTC')).toBe('2026-11-01');
    expect(businessDay('2026-11-01T06:00:00.000Z', 'America/Los_Angeles')).toBe('2026-10-31');
    expect(businessDay('2026-10-31T17:00:00.000Z', 'Asia/Kuala_Lumpur')).toBe('2026-11-01');
  });
});

describe('dailyEarnings', () => {
  it('pays each staff member their commission rate on the money taken that day, plus tips', () => {
    const result = dailyEarnings(
      [
        booking('b1', 'haircut', { capture: capture(1000) }, { tipCents: 500 }), // Maria 40%
        booking('b2', 'color', { capture: capture(2000) }), // Maria 40%
        booking('b3', 'physio', { capture: capture(400) }, { staffId: 'ken' }), // Ken 50%
      ],
      DAY,
      'UTC',
    );
    expect(result).toEqual([
      { staffId: 'ken', netCents: 400, commissionCents: 200, tipCents: 0, totalCents: 200, bookingIds: ['b3'] },
      { staffId: 'maria', netCents: 3000, commissionCents: 1200, tipCents: 500, totalCents: 1700, bookingIds: ['b1', 'b2'] },
    ]);
  });

  it('counts wallet charges, subtracts refunds on the day they happen, and ignores pending money', () => {
    const result = dailyEarnings(
      [
        booking('b1', 'physio', {
          capture: capture(400),
          walletCharges: [
            { orderId: 'O2', captureId: 'W', amountCents: 1600, status: 'COMPLETED', chargedAt: `${DAY}T13:00:00.000Z` },
          ],
          refunds: [
            { refundId: 'R1', amountCents: 100, status: 'COMPLETED', refundedAt: `${DAY}T14:00:00.000Z` },
            { refundId: 'R2', amountCents: 300, status: 'COMPLETED', refundedAt: '2026-11-02T09:00:00.000Z' },
            { refundId: 'R3', amountCents: 50, status: 'FAILED', refundedAt: `${DAY}T15:00:00.000Z` },
          ],
        }),
        booking('b2', 'physio', { capture: capture(2000, `${DAY}T12:00:00.000Z`, 'PENDING') }),
      ],
      DAY,
      'UTC',
    );
    expect(result).toEqual([
      { staffId: 'ken', netCents: 1900, commissionCents: 950, tipCents: 0, totalCents: 950, bookingIds: ['b1'] },
    ]);

    // The later refund lands on its own day as a negative.
    expect(dailyEarnings(
      [booking('b1', 'physio', { refunds: [{ refundId: 'R2', amountCents: 300, status: 'COMPLETED', refundedAt: '2026-11-02T09:00:00.000Z' }] })],
      '2026-11-02',
      'UTC',
    )).toEqual([{ staffId: 'ken', netCents: -300, commissionCents: -150, tipCents: 0, totalCents: -150, bookingIds: ['b1'] }]);
  });

  it('R1(b): money that was PENDING counts on the day it completed, not the day it was recorded', () => {
    const late = booking('b1', 'haircut', {
      capture: { ...capture(1000, '2026-10-31T12:00:00.000Z'), settledAt: `${DAY}T09:00:00.000Z` },
      refunds: [
        { refundId: 'R1', amountCents: 200, status: 'COMPLETED', refundedAt: '2026-10-31T13:00:00.000Z', settledAt: `${DAY}T10:00:00.000Z` },
      ],
    });
    expect(dailyEarnings([late], '2026-10-31', 'UTC')).toEqual([]);
    expect(dailyEarnings([late], DAY, 'UTC')).toEqual([
      { staffId: 'maria', netCents: 800, commissionCents: 320, tipCents: 0, totalCents: 320, bookingIds: ['b1'] },
    ]);
  });

  it('only counts money whose business day matches', () => {
    const late = booking('b1', 'haircut', { capture: capture(1000, '2026-11-02T03:00:00.000Z') });
    expect(dailyEarnings([late], DAY, 'UTC')).toEqual([]);
    expect(dailyEarnings([late], DAY, 'America/Los_Angeles')).toHaveLength(1);
  });

  it('rounds commission to whole cents', () => {
    const [maria] = dailyEarnings([booking('b1', 'haircut', { capture: capture(333) })], DAY, 'UTC');
    expect(maria.commissionCents).toBe(133); // 40% of 3.33 = 1.332
  });
});

describe('readPayoutEmails', () => {
  it('parses staff=email pairs', () => {
    expect(readPayoutEmails({ STAFF_PAYOUT_EMAILS: ' maria=m@example.com , ken=k@example.com ' })).toEqual(
      new Map([
        ['maria', 'm@example.com'],
        ['ken', 'k@example.com'],
      ]),
    );
    expect(readPayoutEmails({})).toEqual(new Map());
  });

  it.each(['maria', 'maria=not-an-email', 'bob=b@example.com', 'maria=a@b.c=d'])('rejects %s', (value) => {
    expect(() => readPayoutEmails({ STAFF_PAYOUT_EMAILS: value })).toThrow(
      expect.objectContaining({ name: 'PayPalConfigError', missing: ['STAFF_PAYOUT_EMAILS'] }),
    );
  });
});
