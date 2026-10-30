import { describe, expect, it } from 'vitest';
import { searchSlots } from '@/lib/booking/availability';
import type { Booking } from '@/lib/booking/store';

// Fixed clock: tests never depend on the real date.
const NOW = new Date('2026-11-01T06:00:00.000Z');
const DAY = '2026-11-02';

function booking(startsAt: string, extra: Partial<Booking> = {}): Booking {
  return {
    id: `b-${startsAt}`,
    serviceId: 'haircut',
    customerName: 'Ana',
    startsAt,
    deposit: { currency: 'USD', cents: 1000 },
    status: 'deposit_held',
    createdAt: NOW.toISOString(),
    staffId: 'maria',
    ...extra,
  };
}

const times = (slots: { startsAt: string }[]) => slots.map((s) => s.startsAt.slice(11, 16));

describe('searchSlots', () => {
  it('offers 30-minute steps inside opening hours that fit the service', () => {
    const slots = searchSlots([], 'haircut', DAY, 'UTC', NOW);
    // Haircut is 45 minutes and the studio closes at 18:00, so 17:00 is the last start.
    expect(times(slots)[0]).toBe('09:00');
    expect(times(slots).at(-1)).toBe('17:00');
    expect(slots).toHaveLength(17);
    expect(new Set(slots.map((s) => s.staffId))).toEqual(new Set(['maria']));
  });

  it('gives each service its own staff member', () => {
    expect(new Set(searchSlots([], 'physio', DAY, 'UTC', NOW).map((s) => s.staffId))).toEqual(new Set(['ken']));
  });

  it('skips times that overlap the staff member\'s active bookings', () => {
    const slots = searchSlots([booking(`${DAY}T10:00:00.000Z`)], 'haircut', DAY, 'UTC', NOW);
    // The 10:00-10:45 haircut blocks 09:30 (would end 10:15), 10:00 and 10:30.
    expect(times(slots)).not.toContain('09:30');
    expect(times(slots)).not.toContain('10:00');
    expect(times(slots)).not.toContain('10:30');
    expect(times(slots)).toContain('09:00');
    expect(times(slots)).toContain('11:00');
  });

  it('ignores cancelled bookings, other staff, and unpaid holds older than 30 minutes', () => {
    const bookings = [
      booking(`${DAY}T10:00:00.000Z`, { status: 'cancelled' }),
      booking(`${DAY}T11:00:00.000Z`, { staffId: 'ken', serviceId: 'physio' }),
      booking(`${DAY}T12:00:00.000Z`, { status: 'awaiting_deposit', createdAt: '2026-11-01T05:00:00.000Z' }),
      booking(`${DAY}T13:00:00.000Z`, { status: 'awaiting_deposit', createdAt: '2026-11-01T05:45:00.000Z' }),
    ];
    const free = times(searchSlots(bookings, 'haircut', DAY, 'UTC', NOW));
    expect(free).toContain('10:00');
    expect(free).toContain('11:00');
    expect(free).toContain('12:00');
    expect(free).not.toContain('13:00');
  });

  it('uses the business time zone for opening hours', () => {
    const slots = searchSlots([], 'haircut', DAY, 'America/Los_Angeles', NOW);
    // 09:00 PST on Nov 2 is 17:00 UTC.
    expect(slots[0].startsAt).toBe('2026-11-02T17:00:00.000Z');
  });

  it('R12: a renewed unpaid claim never blocks for more than an hour after the booking was made', () => {
    const renewedLate = booking(`${DAY}T13:00:00.000Z`, {
      status: 'awaiting_deposit',
      createdAt: '2026-11-01T05:00:00.000Z',
      slotHeldAt: '2026-11-01T05:59:00.000Z', // renewed a minute before the hour
    });
    // At 06:00 (60 minutes after creation) the slot is free again, not at 06:29.
    expect(times(searchSlots([renewedLate], 'haircut', DAY, 'UTC', new Date('2026-11-01T05:59:30.000Z')))).not.toContain('13:00');
    expect(times(searchSlots([renewedLate], 'haircut', DAY, 'UTC', NOW))).toContain('13:00');
  });

  it('R6: zones with a :45 offset still get slots on the local half hour', () => {
    // Kathmandu is UTC+5:45: 09:00 local on Nov 2 is 03:15 UTC.
    const slots = searchSlots([], 'haircut', DAY, 'Asia/Kathmandu', new Date('2026-11-01T00:00:00.000Z'));
    expect(slots[0].startsAt).toBe('2026-11-02T03:15:00.000Z');
    expect(slots[1].startsAt).toBe('2026-11-02T03:45:00.000Z');
  });

  it('nothing in the past, within 30 minutes, or more than 3 days ahead', () => {
    expect(times(searchSlots([], 'haircut', '2026-11-01', 'UTC', new Date('2026-11-01T12:10:00.000Z')))[0]).toBe('13:00');
    expect(searchSlots([], 'haircut', '2026-11-05', 'UTC', NOW)).toEqual([]);
    expect(searchSlots([], 'massage', DAY, 'UTC', NOW)).toEqual([]);
  });
});
