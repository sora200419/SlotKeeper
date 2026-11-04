import { describe, expect, it } from 'vitest';
import {
  actionRequest,
  addDays,
  applyLiveMessage,
  bookingActions,
  centsToInput,
  parseDollars,
  PANEL_START,
  panelReducer,
  panelView,
  replayExpired,
  walletSummary,
  type BoardAction,
  type PanelEvent,
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

describe('bookingActions mirror what the payment layer allows', () => {
  const held = (extra: Partial<BoardBooking> = {}) => booking('b', { hold: { authorizationId: 'AUTH-1' }, ...extra });
  const kinds = (b: BoardBooking) => bookingActions(b).map((a) => a.kind);

  it('a held deposit can be captured, charged as a no-show fee up to the deposit, or released', () => {
    expect(bookingActions(held())).toEqual([{ kind: 'capture', cents: 1000 }, { kind: 'no_show', maxCents: 1000 }, { kind: 'void' }]);
  });

  it('nothing to do without a hold, or once the money is settled', () => {
    expect(kinds(booking('b', { status: 'awaiting_deposit' }))).toEqual([]);
    expect(kinds(booking('b', { status: 'cancelled' }))).toEqual([]);
    expect(kinds(held({ status: 'cancelled' }))).toEqual([]);
    expect(kinds(held({ status: 'refunded', hold: { authorizationId: 'A', capture: { amountCents: 1000 }, refunds: [{ amountCents: 1000 }] } }))).toEqual([]);
  });

  it('a hold PayPal is still reviewing can only be released', () => {
    expect(kinds(held({ status: 'deposit_pending' }))).toEqual(['void']);
  });

  it('a booking under review: release if nothing was captured, otherwise leave it to staff', () => {
    expect(kinds(held({ status: 'deposit_needs_review' }))).toEqual(['void']);
    expect(kinds(held({ status: 'deposit_needs_review', hold: { authorizationId: 'A', capture: { amountCents: 400 } } }))).toEqual([]);
  });

  it('refunds what is still refundable, ignoring failed refunds', () => {
    const b = held({ status: 'partially_refunded', hold: { authorizationId: 'A', capture: { amountCents: 1000 }, refunds: [{ amountCents: 300 }, { amountCents: 500, status: 'FAILED' }] } });
    expect(bookingActions(b)).toEqual([{ kind: 'refund', maxCents: 700 }]);
  });

  it('a saved wallet is charged once, only after completed or no-show, never past the deposit', () => {
    const noShow = (hold: Partial<NonNullable<BoardBooking['hold']>>) =>
      held({ status: 'no_show_charged', hold: { authorizationId: 'A', capture: { amountCents: 400 }, ...hold } });
    expect(bookingActions(noShow({ savedWallet: { status: 'VAULTED' } }))).toEqual([{ kind: 'refund', maxCents: 400 }, { kind: 'wallet', maxCents: 600 }]);
    expect(kinds(noShow({}))).toEqual(['refund']);
    expect(kinds(noShow({ savedWallet: {}, walletCharges: [{ amountCents: 600, status: 'COMPLETED' }] }))).toEqual(['refund']);
    expect(kinds(noShow({ savedWallet: {}, walletCharges: [{ amountCents: 600, status: 'DECLINED' }] }))).toEqual(['refund', 'wallet']);
    expect(kinds(held({ status: 'completed', hold: { authorizationId: 'A', capture: { amountCents: 1000 }, savedWallet: {} } }))).toEqual(['refund']);
    expect(kinds(held({ status: 'partially_refunded', hold: { authorizationId: 'A', capture: { amountCents: 400 }, refunds: [{ amountCents: 100 }], savedWallet: {} } }))).toEqual(['refund']);
  });

  it('an unconfirmed call allows only its own replay', () => {
    expect(bookingActions(held({ hold: { authorizationId: 'A', pendingAction: { kind: 'capture', reason: 'no_show' } } }))).toEqual([
      { kind: 'retry', pending: 'capture', reason: 'no_show' },
    ]);
  });

  it('offers no retry once PayPal has forgotten the request id', () => {
    const now = new Date('2026-11-04T12:00:00Z');
    const since = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
    const pending = (kind: string, hours: number) => held({ hold: { authorizationId: 'A', pendingAction: { kind, since: since(hours) } } });
    expect(bookingActions(pending('wallet_charge', 4), now).map((a) => a.kind)).toEqual(['retry']);
    expect(bookingActions(pending('wallet_charge', 6), now)).toEqual([]);
    expect(bookingActions(pending('refund', 43 * 24), now).map((a) => a.kind)).toEqual(['retry']);
    expect(bookingActions(pending('refund', 45 * 24), now)).toEqual([]);
    expect(replayExpired(pending('refund', 45 * 24), now)).toBe(true);
    expect(replayExpired(pending('refund', 1), now)).toBe(false);
  });
});

describe('walletSummary', () => {
  const charge = (amountCents: number, status: string) => ({ amountCents, status });
  it('never calls a declined or failed charge "charged"', () => {
    expect(walletSummary({ savedWallet: {}, walletCharges: [charge(600, 'DECLINED')] })).toBe('not charged (last try declined)');
    expect(walletSummary({ savedWallet: {}, walletCharges: [charge(600, 'FAILED')] })).toBe('not charged (last try failed)');
  });

  it('adds up money actually taken, and says when PayPal has not settled it', () => {
    expect(walletSummary({ savedWallet: {}, walletCharges: [charge(600, 'DECLINED'), charge(500, 'COMPLETED')] })).toBe('charged $5.00');
    expect(walletSummary({ savedWallet: {}, walletCharges: [charge(500, 'PENDING')] })).toBe('charged $5.00 (pending)');
  });

  it('nothing to show without a saved wallet', () => {
    expect(walletSummary({ savedWallet: {} })).toBe('yes, not charged');
    expect(walletSummary({})).toBeUndefined();
    expect(walletSummary(undefined)).toBeUndefined();
  });
});

describe('booking panel state', () => {
  const NOW = new Date('2026-11-04T12:00:00Z');
  const held = (id: string, extra: Partial<BoardBooking> = {}) => booking(id, { hold: { authorizationId: 'AUTH-1' }, ...extra });
  const run = (...events: PanelEvent[]) => events.reduce(panelReducer, PANEL_START);
  const noShow: BoardAction = { kind: 'no_show', maxCents: 1000 };

  it('shows a result only on the booking it belongs to, even after switching mid-request', () => {
    const a = held('a');
    const b = held('b');
    // Start A's request, switch to B and choose there, then A's answer arrives.
    const state = run(
      { type: 'choose', bookingId: 'a', action: noShow },
      { type: 'start', bookingId: 'a' },
      { type: 'choose', bookingId: 'b', action: { kind: 'void' } },
      { type: 'finish', bookingId: 'a', ok: true, text: 'Done. No-show fee.' },
    );
    const onB = panelView(state, b, NOW);
    expect(onB.message).toBeUndefined();
    expect(onB.sending).toBe(false);
    expect(onB.chosen).toEqual({ kind: 'void' });
    const onA = panelView(state, a, NOW);
    expect(onA.message).toEqual({ kind: 'done', text: 'Done. No-show fee.' });
    expect(onA.chosen).toBeUndefined();
  });

  it('a request in flight disables only its own booking', () => {
    const state = run({ type: 'start', bookingId: 'a' });
    expect(panelView(state, held('a'), NOW).sending).toBe(true);
    expect(panelView(state, held('b'), NOW).sending).toBe(false);
  });

  it('keeps the choice open after an error, and clears it after success', () => {
    const failed = run({ type: 'choose', bookingId: 'a', action: noShow }, { type: 'start', bookingId: 'a' }, { type: 'finish', bookingId: 'a', ok: false, text: 'Declined' });
    expect(panelView(failed, held('a'), NOW)).toMatchObject({ chosen: noShow, message: { kind: 'error', text: 'Declined' } });
  });

  it('drops a choice the booking no longer allows, and checks amounts against its current limit', () => {
    const chosen = run({ type: 'choose', bookingId: 'a', action: noShow }, { type: 'amount', value: '8' });
    // Captured meanwhile (webhook or copilot): no-show is no longer offered.
    expect(panelView(chosen, held('a', { status: 'completed', hold: { authorizationId: 'A', capture: { amountCents: 1000 } } }), NOW).chosen).toBeUndefined();

    const refund = run({ type: 'choose', bookingId: 'a', action: { kind: 'refund', maxCents: 1000 } }, { type: 'amount', value: '8' });
    const partly = held('a', { status: 'partially_refunded', hold: { authorizationId: 'A', capture: { amountCents: 1000 }, refunds: [{ amountCents: 500 }] } });
    const view = panelView(refund, partly, NOW);
    expect(view.chosen).toEqual({ kind: 'refund', maxCents: 500 });
    expect(view.parsed).toEqual({ ok: false, message: 'The amount can be at most $5.00.' });
  });

  it('fills the amount with the most the action allows', () => {
    expect(panelView(run({ type: 'choose', bookingId: 'a', action: noShow }), held('a'), NOW).amount).toBe('10.00');
  });
});

describe('actionRequest', () => {
  it.each([
    [{ kind: 'capture', cents: 1000 }, undefined, '/deposit/capture', { reason: 'completed' }],
    [{ kind: 'no_show', maxCents: 1000 }, 400, '/deposit/capture', { reason: 'no_show', amountCents: 400 }],
    [{ kind: 'void' }, undefined, '/deposit/void', undefined],
    [{ kind: 'refund', maxCents: 1000 }, 250, '/deposit/refund', { amountCents: 250 }],
    [{ kind: 'wallet', maxCents: 600 }, 600, '/wallet/charge', { amountCents: 600 }],
    [{ kind: 'retry', pending: 'capture', reason: 'no_show' }, undefined, '/deposit/capture', { reason: 'no_show' }],
    [{ kind: 'retry', pending: 'refund' }, undefined, '/deposit/refund', {}],
    [{ kind: 'retry', pending: 'reauthorize' }, undefined, '/deposit/reauthorize', undefined],
    [{ kind: 'retry', pending: 'wallet_charge' }, undefined, '/wallet/charge', {}],
  ] as Array<[BoardAction, number | undefined, string, unknown]>)('%j', (action, cents, path, body) => {
    expect(actionRequest(action, 'b 1', cents)).toEqual({ path: `/api/bookings/b%201${path}`, ...(body === undefined ? {} : { body }) });
  });
});

describe('parseDollars', () => {
  it.each([
    ['4', 400],
    ['4.5', 450],
    ['4.50', 450],
    ['4,50', 450],
    ['$4.50', 450],
    ['  10 USD ', 1000],
    ['0.01', 1],
    ['1,234.50', 123450],
    ['1.234,50', 123450],
  ])('%s -> %i cents', (input, cents) => {
    expect(parseDollars(input, 1_000_000)).toEqual({ ok: true, cents });
  });

  it.each(['4,500', '1.234', '1,234,567'])('refuses the ambiguous %s rather than guessing', (input) => {
    expect(parseDollars(input, 1_000_000)).toMatchObject({ ok: false, message: expect.stringContaining('two different amounts') });
  });

  it.each(['', 'abc', '4.567', '4..5', '-4', '4.5.6', '1,23.50', '0', '0.00'])('refuses %j', (input) => {
    expect(parseDollars(input, 1_000_000).ok).toBe(false);
  });

  it('refuses more than the limit and says what the limit is', () => {
    expect(parseDollars('10.01', 1000)).toEqual({ ok: false, message: 'The amount can be at most $10.00.' });
    expect(parseDollars('10', 1000)).toEqual({ ok: true, cents: 1000 });
  });

  it('calls a huge amount too large, not too small', () => {
    expect(parseDollars('99999999999999999999', 1000)).toEqual({ ok: false, message: 'The amount can be at most $10.00.' });
  });

  it('shows cents back as an amount the parser accepts', () => {
    expect(centsToInput(400)).toBe('4.00');
    expect(parseDollars(centsToInput(1234), 2000)).toEqual({ ok: true, cents: 1234 });
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
