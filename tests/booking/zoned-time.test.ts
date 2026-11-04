import { describe, expect, it } from 'vitest';
import { defaultSlotIn, formatInZone, newBookingBody, ZonedTimeError, zonedWallTimeToUtc } from '@/lib/booking/zoned-time';

const LA = 'America/Los_Angeles';

describe('zonedWallTimeToUtc: the form time is shop time, not browser time', () => {
  it('reads 10:00 as 10:00 in Los Angeles, in winter (PST, UTC-8) and summer (PDT, UTC-7)', () => {
    expect(zonedWallTimeToUtc('2026-11-05T10:00', LA)).toBe('2026-11-05T18:00:00.000Z');
    expect(zonedWallTimeToUtc('2026-10-20T10:00', LA)).toBe('2026-10-20T17:00:00.000Z');
  });

  it('does not depend on the zone of the machine running it', () => {
    // The same wall time in other zones gives other instants; the browser zone never enters.
    expect(zonedWallTimeToUtc('2026-11-05T10:00', 'UTC')).toBe('2026-11-05T10:00:00.000Z');
    expect(zonedWallTimeToUtc('2026-11-05T10:00', 'Asia/Kuala_Lumpur')).toBe('2026-11-05T02:00:00.000Z');
  });

  it('crosses midnight into the next UTC day', () => {
    expect(zonedWallTimeToUtc('2026-11-05T19:00', LA)).toBe('2026-11-06T03:00:00.000Z');
  });

  it('accepts seconds from the field', () => {
    expect(zonedWallTimeToUtc('2026-11-05T10:00:00', LA)).toBe('2026-11-05T18:00:00.000Z');
  });

  it('takes the first of a time that happens twice when clocks go back', () => {
    // 2026-11-01 01:30 happens at 08:30Z (PDT) and again at 09:30Z (PST).
    expect(zonedWallTimeToUtc('2026-11-01T01:30', LA)).toBe('2026-11-01T08:30:00.000Z');
  });

  it('refuses a time the clocks skip when they go forward', () => {
    // 2026-03-08 02:00-02:59 does not exist in Los Angeles.
    expect(() => zonedWallTimeToUtc('2026-03-08T02:30', LA)).toThrow(ZonedTimeError);
    expect(zonedWallTimeToUtc('2026-03-08T03:00', LA)).toBe('2026-03-08T10:00:00.000Z');
  });

  it.each(['', 'tomorrow', '2026-11-05', '2026-02-30T10:00', '2026-11-05 10:00', '2026-11-05T10:60', '2026-11-05T24:00', '0026-11-05T10:00'])('refuses %j', (value) => {
    expect(() => zonedWallTimeToUtc(value, LA)).toThrow(ZonedTimeError);
  });
});

describe('newBookingBody: what the booking form posts', () => {
  it('sends 10:00 typed in the form as 10:00 Los Angeles time, whatever zone the browser is in', () => {
    expect(newBookingBody({ serviceId: 'haircut', customerName: 'Justin', startsAt: '2026-11-05T10:00' }, LA)).toEqual({
      serviceId: 'haircut',
      customerName: 'Justin',
      startsAt: '2026-11-05T18:00:00.000Z',
    });
  });

  it('refuses a missing time instead of sending a guess', () => {
    expect(() => newBookingBody({ serviceId: 'haircut', customerName: 'J', startsAt: null }, LA)).toThrow(ZonedTimeError);
  });
});

describe('defaultSlotIn', () => {
  it('is tomorrow at 10:00 in the shop zone, even when the UTC date is already a day ahead', () => {
    // 05:30Z on 11-05 is still the evening of 11-04 in Los Angeles.
    expect(defaultSlotIn(new Date('2026-11-05T05:30:00Z'), LA)).toBe('2026-11-05T10:00');
    expect(defaultSlotIn(new Date('2026-11-05T05:30:00Z'), 'UTC')).toBe('2026-11-06T10:00');
  });

  it('rolls over the month', () => {
    expect(defaultSlotIn(new Date('2026-11-30T20:00:00Z'), LA)).toBe('2026-12-01T10:00');
  });
});

describe('formatInZone', () => {
  it('shows the shop time and zone, not GMT', () => {
    expect(formatInZone('2026-11-06T03:00:00.000Z', LA)).toBe('Thursday, November 5, 2026, 19:00 PST (America/Los_Angeles)');
  });

  it('round-trips with the form: what was typed is what is shown', () => {
    expect(formatInZone(zonedWallTimeToUtc('2026-11-05T10:00', LA), LA)).toContain('November 5, 2026, 10:00 PST');
  });
});
