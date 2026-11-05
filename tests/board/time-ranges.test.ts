import { describe, expect, it } from 'vitest';
import { CLOSE_MINUTE, OPEN_MINUTE } from '@/lib/booking/availability';
import { boardTimeRanges, SHOP_CLOSE_HOUR, SHOP_OPEN_HOUR } from '@/lib/board/view';

const LA = 'America/Los_Angeles';

describe('board time ranges', () => {
  it('uses the same opening hours as the slot search', () => {
    expect(SHOP_OPEN_HOUR * 60).toBe(OPEN_MINUTE);
    expect(SHOP_CLOSE_HOUR * 60).toBe(CLOSE_MINUTE);
  });

  it('shades the closed hours of the day in shop time', () => {
    const ranges = boardTimeRanges('2026-11-06', new Date('2026-11-01T00:00:00Z'), LA);
    expect(ranges).toEqual([
      { id: 'closed-morning', startDate: '2026-11-06T00:00:00', endDate: '2026-11-06T09:00:00', cls: 'sk-closed' },
      { id: 'closed-evening', startDate: '2026-11-06T18:00:00', endDate: '2026-11-07T00:00:00', cls: 'sk-closed' },
    ]);
  });

  it('draws the Now line at shop time, not the viewer clock, only on that shop day', () => {
    // 04:05Z on 11-05 is 20:05 on 11-04 in Los Angeles: a viewer in UTC+8 sees 12:05 on 11-05 on their own clock.
    const now = new Date('2026-11-05T04:05:00Z');
    expect(boardTimeRanges('2026-11-04', now, LA).find((r) => r.id === 'now')).toEqual({
      id: 'now',
      startDate: '2026-11-04T20:05:00',
      name: 'Now',
      cls: 'sk-now',
    });
    expect(boardTimeRanges('2026-11-05', now, LA).find((r) => r.id === 'now')).toBeUndefined();
  });
});
