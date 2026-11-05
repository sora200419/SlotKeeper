import { describe, expect, it } from 'vitest';
import { bookingEvent, boardEvents, dropToMove, type BoardBooking, type Plan } from '@/lib/board/view';

const services = [{ id: 'haircut', name: 'Haircut', durationMinutes: 45 }];

function booking(id: string, status: BoardBooking['status']): BoardBooking {
  return {
    id,
    serviceId: 'haircut',
    customerName: id,
    startsAt: '2026-11-05T18:00:00.000Z',
    deposit: { currency: 'USD', cents: 1000 },
    status,
    createdAt: '2026-11-05T16:00:00.000Z',
    staffId: 'maria',
  } as BoardBooking;
}

describe('which bookings can be dragged on the board', () => {
  it('drags bookings the server lets move, never finished ones', () => {
    for (const status of ['awaiting_deposit', 'deposit_held', 'deposit_pending', 'deposit_needs_review'] as const) {
      expect(bookingEvent(booking('a', status), services).draggable).toBe(true);
    }
    for (const status of ['completed', 'no_show_charged', 'cancelled', 'refunded', 'partially_refunded'] as const) {
      expect(bookingEvent(booking('a', status), services).draggable).toBe(false);
    }
  });

  it('drags nothing while a plan is previewed, ghosts included', () => {
    const plan = {
      id: 'p',
      request: 'r',
      summary: 's',
      status: 'proposed',
      steps: [{ type: 'move_booking', bookingId: 'a', startsAt: '2026-11-05T19:00:00.000Z', why: 'w' }],
    } as unknown as Plan;
    const events = boardEvents([booking('a', 'deposit_held'), booking('b', 'deposit_held')], services, plan);
    expect(events.some((e) => e.ghost)).toBe(true);
    expect(events.every((e) => e.draggable === false)).toBe(true);
  });
});

describe('dropToMove', () => {
  it('reads the dropped local wall-clock time as shop time, whatever the machine zone', () => {
    // The scheduler shows shop wall-clock time in local Dates: 11:30 on the board is 11:30 in Los Angeles.
    expect(dropToMove(new Date(2026, 10, 5, 11, 30), 'ken', 'America/Los_Angeles')).toEqual({
      startsAt: '2026-11-05T19:30:00.000Z',
      staffId: 'ken',
    });
    expect(dropToMove(new Date(2026, 9, 20, 9, 0), 'maria', 'America/Los_Angeles').startsAt).toBe('2026-10-20T16:00:00.000Z');
  });
});
