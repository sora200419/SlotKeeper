import { describe, expect, it } from 'vitest';
import {
  addDays,
  applyLiveMessage,
  boardEvents,
  boardResources,
  bookingEvent,
  createSseParser,
  dayHours,
  dayInZone,
  MONEY,
  nextBookedDay,
  planDay,
  stepTitle,
  upsertBooking,
  wallClock,
  type BoardBooking,
  type BookingStatus,
  type Plan,
} from '@/lib/board/view';

const services = [{ id: 'haircut', name: 'Haircut', durationMinutes: 45 }];
const staff = [{ id: 'maria', name: 'Maria' }, { id: 'ken', name: 'Ken' }];

const booking = (id: string, extra: Partial<BoardBooking> = {}): BoardBooking => ({
  id,
  serviceId: 'haircut',
  customerName: 'Ana',
  startsAt: '2026-11-02T17:00:00.000Z',
  status: 'deposit_held',
  deposit: { currency: 'USD', cents: 1000 },
  staffId: 'maria',
  ...extra,
});

const plan = (steps: Plan['steps'], status: Plan['status'] = 'proposed'): Plan => ({ id: 'p', request: 'r', summary: 's', steps, status, createdAt: 'x' });

describe('bookingEvent', () => {
  it('ends after the service duration and carries the money state', () => {
    expect(bookingEvent(booking('b'), services)).toMatchObject({
      resourceId: 'maria',
      startDate: '2026-11-02T17:00:00.000Z',
      endDate: '2026-11-02T17:45:00.000Z',
      moneyState: 'held',
      moneyLabel: 'Deposit held',
      amount: '$10.00',
    });
  });

  it('every status has a colour state', () => {
    const statuses: BookingStatus[] = ['awaiting_deposit', 'deposit_held', 'deposit_pending', 'deposit_needs_review', 'completed', 'no_show_charged', 'cancelled', 'partially_refunded', 'refunded'];
    for (const status of statuses) expect(MONEY[status].state).toBeTruthy();
  });

  it('shows what was actually captured, which can be less than the deposit', () => {
    const noShow = booking('b', { status: 'no_show_charged', hold: { capture: { amountCents: 400 } } });
    expect(bookingEvent(noShow, services).amount).toBe('$4.00');
  });

  it('marks agent bookings, and a booking with no staff lands in the Unassigned row', () => {
    const event = bookingEvent(booking('b', { source: 'agent', staffId: undefined }), services);
    expect(event).toMatchObject({ viaAgent: true, resourceId: 'unassigned' });
    expect(boardResources(staff, [event]).map((r) => r.id)).toEqual(['maria', 'ken', 'unassigned']);
    expect(boardResources(staff, [bookingEvent(booking('c'), services)])).toEqual(staff);
  });
});

describe('boardEvents plan preview', () => {
  it('draws a ghost at the destination and fades the original', () => {
    const events = boardEvents([booking('b')], services, plan([{ type: 'move_booking', bookingId: 'b', staffId: 'ken', startsAt: '2026-11-02T19:00:00.000Z', why: 'w' }]));
    const original = events.find((e) => e.id === 'b')!;
    const ghost = events.find((e) => e.id === 'ghost-b')!;
    expect(original).toMatchObject({ movingAway: true, resourceId: 'maria' });
    expect(ghost).toMatchObject({ ghost: true, resourceId: 'ken', startDate: '2026-11-02T19:00:00.000Z', endDate: '2026-11-02T19:45:00.000Z' });
  });

  it('a move with only a new staff member keeps the time', () => {
    const events = boardEvents([booking('b')], services, plan([{ type: 'move_booking', bookingId: 'b', staffId: 'ken', why: 'w' }]));
    expect(events.find((e) => e.ghost)).toMatchObject({ resourceId: 'ken', startDate: '2026-11-02T17:00:00.000Z' });
  });

  it('two moves of one booking combine into one ghost', () => {
    const events = boardEvents(
      [booking('b')],
      services,
      plan([
        { type: 'move_booking', bookingId: 'b', staffId: 'ken', why: 'w' },
        { type: 'move_booking', bookingId: 'b', startsAt: '2026-11-02T20:00:00.000Z', why: 'w' },
      ]),
    );
    expect(events.filter((e) => e.ghost)).toHaveLength(1);
    expect(events.find((e) => e.ghost)).toMatchObject({ resourceId: 'ken', startDate: '2026-11-02T20:00:00.000Z' });
  });

  it('money steps add a note, on the ghost too when the booking also moves', () => {
    const events = boardEvents(
      [booking('b'), booking('c')],
      services,
      plan([
        { type: 'void_deposit', bookingId: 'c', why: 'w' },
        { type: 'move_booking', bookingId: 'b', staffId: 'ken', why: 'w' },
        { type: 'capture_deposit', bookingId: 'b', reason: 'no_show', amountCents: 400, why: 'w' },
      ]),
    );
    expect(events.find((e) => e.id === 'c')!.planNote).toBe('Will release hold');
    expect(events.find((e) => e.id === 'ghost-b')!.planNote).toBe('Will charge $4.00');
  });

  it.each(['executed', 'failed', 'rejected'] as const)('a %s plan previews nothing', (status) => {
    const events = boardEvents([booking('b')], services, plan([{ type: 'move_booking', bookingId: 'b', staffId: 'ken', why: 'w' }], status));
    expect(events).toHaveLength(1);
    expect(events[0].movingAway).toBeUndefined();
  });

  it('a step for a booking not on the board is ignored', () => {
    expect(boardEvents([booking('b')], services, plan([{ type: 'void_deposit', bookingId: 'gone', why: 'w' }]))).toHaveLength(1);
  });

  it('does not change the booking list it was given', () => {
    const list = [booking('b')];
    const copy = structuredClone(list);
    boardEvents(list, services, plan([{ type: 'move_booking', bookingId: 'b', staffId: 'ken', why: 'w' }]));
    expect(list).toEqual(copy);
  });
});

describe('stepTitle', () => {
  it.each([
    [{ type: 'move_booking', bookingId: 'b', staffId: 'ken', why: 'w' }, 'Move Ana to Ken'],
    [{ type: 'void_deposit', bookingId: 'b', why: 'w' }, 'Release hold · Ana'],
    [{ type: 'capture_deposit', bookingId: 'b', reason: 'completed', why: 'w' }, 'Capture $10.00 · Ana'],
    [{ type: 'capture_deposit', bookingId: 'b', reason: 'no_show', amountCents: 400, why: 'w' }, 'Charge no-show fee $4.00 · Ana'],
    [{ type: 'refund_deposit', bookingId: 'b', amountCents: 250, why: 'w' }, 'Refund $2.50 · Ana'],
    [{ type: 'run_payouts', day: '2026-11-01', why: 'w' }, 'Pay staff for 2026-11-01'],
  ] as Array<[Plan['steps'][number], string]>)('%j', (step, title) => {
    expect(stepTitle(step, [booking('b')], staff)).toBe(title);
  });
});

describe('amounts the owner approves', () => {
  const captured = (cents: number, refunds: Array<{ amountCents: number; status?: string }> = []) =>
    booking('b', { status: 'partially_refunded', hold: { capture: { amountCents: cents }, refunds } });

  it('a refund with no amount shows what the payment layer will really refund', () => {
    const step: Plan['steps'][number] = { type: 'refund_deposit', bookingId: 'b', why: 'w' };
    const part = captured(1000, [{ amountCents: 300, status: 'COMPLETED' }, { amountCents: 500, status: 'FAILED' }]);
    expect(stepTitle(step, [part], staff)).toBe('Refund $7.00 · Ana');
    expect(boardEvents([part], services, plan([step]))[0].planNote).toBe('Will refund $7.00');
  });

  it('a wallet charge with no amount shows the rest of the deposit', () => {
    const step: Plan['steps'][number] = { type: 'charge_saved_wallet', bookingId: 'b', why: 'w' };
    const noShow = booking('b', { status: 'no_show_charged', hold: { capture: { amountCents: 400 } } });
    expect(stepTitle(step, [noShow], staff)).toBe('Charge saved wallet $6.00 · Ana');
    expect(boardEvents([noShow], services, plan([step]))[0].planNote).toBe('Will charge wallet $6.00');
  });
});

describe('money state wording', () => {
  it.each([
    ['a pending capture', { pendingAction: { kind: 'capture' } }],
    ['an unknown authorize', { authorizeOutcomeUnknown: true }],
  ])('%s shows as needing attention, whatever the status says', (_name, hold) => {
    expect(bookingEvent(booking('b', { hold }), services)).toMatchObject({ moneyState: 'review', moneyLabel: 'Confirming with PayPal' });
  });

  it('a booking cancelled before paying never had a hold', () => {
    expect(bookingEvent(booking('b', { status: 'cancelled' }), services)).toMatchObject({ moneyLabel: 'Cancelled', amount: '' });
    expect(bookingEvent(booking('b', { status: 'cancelled', hold: { authorizationId: 'A' } }), services)).toMatchObject({ moneyLabel: 'Hold released', amount: '$10.00' });
  });

  it('refund states show the money that moved', () => {
    const hold = { capture: { amountCents: 1000 }, refunds: [{ amountCents: 300 }] };
    expect(bookingEvent(booking('b', { status: 'partially_refunded', hold }), services).amount).toBe('$7.00');
    expect(bookingEvent(booking('b', { status: 'refunded', hold: { ...hold, refunds: [{ amountCents: 1000 }] } }), services).amount).toBe('$10.00');
  });
});

describe('keeping a plan on screen', () => {
  const zone = 'America/Los_Angeles';

  it('goes to where the first step acts, using a move\'s destination', () => {
    const list = [booking('b', { startsAt: '2026-11-05T18:00:00.000Z' })];
    expect(planDay(plan([{ type: 'void_deposit', bookingId: 'b', why: 'w' }]), list, zone)).toBe('2026-11-05');
    expect(planDay(plan([{ type: 'move_booking', bookingId: 'b', startsAt: '2026-11-07T18:00:00.000Z', why: 'w' }]), list, zone)).toBe('2026-11-07');
    expect(planDay(plan([{ type: 'run_payouts', day: '2026-11-01', why: 'w' }]), list, zone)).toBeUndefined();
  });

  it('shows the working day, stretched for events outside it', () => {
    const at = (startsAt: string) => bookingEvent(booking('b', { startsAt }), services);
    expect(dayHours([at('2026-11-05T18:00:00.000Z')], '2026-11-05', zone)).toEqual({ open: 8, close: 20 });
    expect(dayHours([at('2026-11-05T14:30:00.000Z')], '2026-11-05', zone)).toEqual({ open: 6, close: 20 });
    expect(dayHours([at('2026-11-06T04:30:00.000Z')], '2026-11-05', zone)).toEqual({ open: 8, close: 22 });
    expect(dayHours([at('2026-11-06T07:45:00.000Z')], '2026-11-05', zone)).toEqual({ open: 8, close: 24 });
  });
});

describe('upsertBooking', () => {
  it('replaces in place and appends new bookings', () => {
    const list = [booking('a'), booking('b')];
    expect(upsertBooking(list, booking('a', { status: 'completed' })).map((b) => [b.id, b.status])).toEqual([['a', 'completed'], ['b', 'deposit_held']]);
    expect(upsertBooking(list, booking('c')).map((b) => b.id)).toEqual(['a', 'b', 'c']);
    expect(list[0].status).toBe('deposit_held');
  });
});

describe('days', () => {
  it('uses the business time zone, not the browser or UTC', () => {
    const lateEvening = new Date('2026-11-03T05:00:00.000Z');
    expect(dayInZone(lateEvening, 'America/Los_Angeles')).toBe('2026-11-02');
    expect(dayInZone(lateEvening, 'UTC')).toBe('2026-11-03');
  });

  it('turns an instant into business wall-clock time, across daylight saving', () => {
    expect(wallClock('2026-10-31T17:00:00.000Z', 'America/Los_Angeles')).toBe('2026-10-31T10:00:00');
    expect(wallClock('2026-11-02T17:00:00.000Z', 'America/Los_Angeles')).toBe('2026-11-02T09:00:00');
    expect(wallClock('2026-11-02T00:00:00.000Z', 'UTC')).toBe('2026-11-02T00:00:00');
  });

  it('adds days across a month end', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
  });

  it('finds the next booked day and skips cancelled bookings', () => {
    const list = [
      booking('a', { startsAt: '2026-11-05T17:00:00.000Z' }),
      booking('b', { startsAt: '2026-11-03T17:00:00.000Z', status: 'cancelled' }),
    ];
    expect(nextBookedDay(list, '2026-11-01', 'UTC')).toBe('2026-11-05');
    expect(nextBookedDay(list, '2026-11-05', 'UTC')).toBeUndefined();
  });
});

describe('applyLiveMessage', () => {
  const board = { staff, services, timeZone: 'UTC', bookings: [booking('a')], unsavedWrites: 0 };

  it('the unsaved-writes count rises and falls while the board stays open', () => {
    const behind = applyLiveMessage(board, { event: 'storage', data: '{"unsavedWrites":3}' });
    expect(behind.unsavedWrites).toBe(3);
    expect(applyLiveMessage(behind, { event: 'storage', data: '{"unsavedWrites":0}' }).unsavedWrites).toBe(0);
  });

  it('a booking event updates the bookings and leaves the count alone', () => {
    const next = applyLiveMessage({ ...board, unsavedWrites: 2 }, { event: 'booking', data: JSON.stringify(booking('a', { status: 'completed' })) });
    expect(next.bookings[0].status).toBe('completed');
    expect(next.unsavedWrites).toBe(2);
  });

  it('ignores anything else', () => {
    expect(applyLiveMessage(board, { event: 'other', data: '{}' })).toBe(board);
  });
});

describe('createSseParser', () => {
  it('reads an event split across chunks and ignores comments', () => {
    const parse = createSseParser();
    expect(parse(': connected\n\nevent: boo')).toEqual([]);
    expect(parse('king\nid: 1\ndata: {"a"')).toEqual([]);
    expect(parse(':1}\n\n: ping\n\n')).toEqual([{ event: 'booking', data: '{"a":1}' }]);
  });

  it('returns several events from one chunk', () => {
    const parse = createSseParser();
    expect(parse('event: booking\ndata: 1\n\nevent: booking\ndata: 2\n\n').map((m) => m.data)).toEqual(['1', '2']);
  });
});
