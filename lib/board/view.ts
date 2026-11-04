/**
 * Pure logic behind the staff board, shared by the browser components and their tests. Nothing here
 * talks to the server: bookings and plans arrive as JSON from the staff API.
 */
import { REPLAY_WINDOW_MS } from '@/lib/booking/replay-windows';

export type BookingStatus =
  | 'awaiting_deposit'
  | 'deposit_held'
  | 'deposit_pending'
  | 'deposit_needs_review'
  | 'completed'
  | 'no_show_charged'
  | 'cancelled'
  | 'partially_refunded'
  | 'refunded';

export interface BoardBooking {
  id: string;
  serviceId: string;
  customerName: string;
  startsAt: string;
  status: BookingStatus;
  deposit: { currency: string; cents: number };
  staffId?: string;
  source?: 'web' | 'agent';
  hold?: {
    authorizationId?: string;
    capture?: { amountCents: number };
    refunds?: Array<{ amountCents: number; status?: string }>;
    pendingAction?: { kind: string; reason?: 'completed' | 'no_show'; since?: string };
    authorizeOutcomeUnknown?: boolean;
    savedWallet?: { status?: string };
    walletCharges?: Array<{ amountCents: number; status: string }>;
  };
}

export interface BoardStaff {
  id: string;
  name: string;
}

export interface BoardService {
  id: string;
  name: string;
  durationMinutes: number;
}

export interface BoardData {
  staff: BoardStaff[];
  services: BoardService[];
  timeZone: string;
  bookings: BoardBooking[];
  /** Records not yet in Postgres; above zero means the database is behind. */
  unsavedWrites: number;
}

export type MoneyState = 'due' | 'held' | 'review' | 'captured' | 'noshow' | 'refunded' | 'released';

/** The board's colour language: one state per colour, and the wording shown on the event. */
export const MONEY: Record<BookingStatus, { state: MoneyState; label: string }> = {
  awaiting_deposit: { state: 'due', label: 'Deposit due' },
  deposit_pending: { state: 'held', label: 'PayPal reviewing' },
  deposit_held: { state: 'held', label: 'Deposit held' },
  deposit_needs_review: { state: 'review', label: 'Needs review' },
  completed: { state: 'captured', label: 'Captured' },
  no_show_charged: { state: 'noshow', label: 'No-show fee' },
  partially_refunded: { state: 'refunded', label: 'Part refunded' },
  refunded: { state: 'refunded', label: 'Refunded' },
  cancelled: { state: 'released', label: 'Hold released' },
};

export const LEGEND: Array<{ state: MoneyState; label: string }> = [
  { state: 'due', label: 'Deposit due' },
  { state: 'held', label: 'Held' },
  { state: 'captured', label: 'Captured' },
  { state: 'noshow', label: 'No-show' },
  { state: 'refunded', label: 'Refunded' },
  { state: 'review', label: 'Review' },
  { state: 'released', label: 'Released' },
];

export const UNASSIGNED = 'unassigned';

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export interface BoardEvent {
  id: string;
  resourceId: string;
  startDate: string;
  endDate: string;
  name: string;
  serviceName: string;
  moneyState: MoneyState;
  moneyLabel: string;
  amount: string;
  viaAgent: boolean;
  /** What an open plan would do to this booking, e.g. "Release hold". */
  planNote?: string;
  /** A preview of where a plan would put the booking; not a real booking. */
  ghost?: boolean;
  /** The booking an open plan would move away from here. */
  movingAway?: boolean;
  draggable: false;
  resizable: false;
}

/** Same rule as the payment layer: failed and cancelled refunds gave nothing back. */
function refundedSoFar(booking: BoardBooking): number {
  return (booking.hold?.refunds ?? [])
    .filter((r) => r.status !== 'FAILED' && r.status !== 'CANCELLED')
    .reduce((sum, r) => sum + r.amountCents, 0);
}

/** What refund_deposit takes when the plan gives no amount: everything still refundable. */
function refundable(booking: BoardBooking): number {
  return (booking.hold?.capture?.amountCents ?? 0) - refundedSoFar(booking);
}

/** What charge_saved_wallet takes when the plan gives no amount: the deposit not yet captured. */
function walletRemainder(booking: BoardBooking): number {
  return booking.deposit.cents - (booking.hold?.capture?.amountCents ?? 0);
}

/**
 * The money actions the board offers for a booking. They mirror the rules in
 * lib/paypal/deposit-actions.ts, which still decides: the board only avoids offering a button that
 * is bound to be refused.
 */
export type BoardAction =
  | { kind: 'capture'; cents: number }
  | { kind: 'no_show'; maxCents: number }
  | { kind: 'void' }
  | { kind: 'refund'; maxCents: number }
  | { kind: 'wallet'; maxCents: number }
  /** A call whose outcome PayPal never confirmed: only the same call, replayed, is allowed. */
  | { kind: 'retry'; pending: string; reason?: 'completed' | 'no_show' };

const WALLET_STATUSES: BookingStatus[] = ['completed', 'no_show_charged'];
const FAILED_CHARGES = new Set(['DECLINED', 'FAILED']);

/** The panel's "Saved wallet" line. A declined or failed charge took no money, so it is never "charged". */
export function walletSummary(hold: BoardBooking['hold']): string | undefined {
  if (!hold?.savedWallet) return undefined;
  const charges = hold.walletCharges ?? [];
  const taken = charges.filter((c) => !FAILED_CHARGES.has(c.status));
  if (taken.length > 0) {
    const pending = taken.some((c) => c.status !== 'COMPLETED');
    return `charged ${dollars(taken.reduce((sum, c) => sum + c.amountCents, 0))}${pending ? ' (pending)' : ''}`;
  }
  const last = charges.at(-1);
  return last ? `not charged (last try ${last.status.toLowerCase()})` : 'yes, not charged';
}

/**
 * A call PayPal never confirmed, too old to replay: PayPal has forgotten its request id, so the server
 * refuses the replay and sends the booking to review. Staff must check PayPal instead.
 */
export function replayExpired(booking: BoardBooking, now: Date = new Date()): boolean {
  const pending = booking.hold?.pendingAction;
  if (!pending?.since) return false;
  const window = (REPLAY_WINDOW_MS as Record<string, number>)[pending.kind];
  return window !== undefined && now.getTime() - Date.parse(pending.since) > window;
}

export function bookingActions(booking: BoardBooking, now: Date = new Date()): BoardAction[] {
  const hold = booking.hold;
  // No authorization means no hold: every money action needs one.
  if (!hold?.authorizationId) return [];
  if (hold.pendingAction) {
    // While a call is unconfirmed the server only accepts its replay, and only inside the window.
    if (replayExpired(booking, now)) return [];
    return [{ kind: 'retry', pending: hold.pendingAction.kind, reason: hold.pendingAction.reason }];
  }

  switch (booking.status) {
    case 'deposit_held':
      return [{ kind: 'capture', cents: booking.deposit.cents }, { kind: 'no_show', maxCents: booking.deposit.cents }, { kind: 'void' }];
    case 'deposit_pending':
      return [{ kind: 'void' }];
    case 'deposit_needs_review':
      // A captured deposit can't be voided, and a refund waits until staff have checked it.
      return hold.capture ? [] : [{ kind: 'void' }];
    case 'completed':
    case 'no_show_charged':
    case 'partially_refunded': {
      const actions: BoardAction[] = [];
      const left = refundable(booking);
      if (left > 0) actions.push({ kind: 'refund', maxCents: left });
      const charged = (hold.walletCharges ?? []).some((c) => !FAILED_CHARGES.has(c.status));
      const remainder = walletRemainder(booking);
      if (WALLET_STATUSES.includes(booking.status) && hold.savedWallet && !charged && remainder >= 1) {
        actions.push({ kind: 'wallet', maxCents: remainder });
      }
      return actions;
    }
    default:
      return [];
  }
}

/** The staff route and body for an action. `cents` is the amount the owner confirmed, where one applies. */
export function actionRequest(action: BoardAction, bookingId: string, cents?: number): { path: string; body?: Record<string, unknown> } {
  const base = `/api/bookings/${encodeURIComponent(bookingId)}`;
  switch (action.kind) {
    case 'capture':
      return { path: `${base}/deposit/capture`, body: { reason: 'completed' } };
    case 'no_show':
      return { path: `${base}/deposit/capture`, body: { reason: 'no_show', amountCents: cents } };
    case 'void':
      return { path: `${base}/deposit/void` };
    case 'refund':
      return { path: `${base}/deposit/refund`, body: { amountCents: cents } };
    case 'wallet':
      return { path: `${base}/wallet/charge`, body: { amountCents: cents } };
    case 'retry':
      // No amount: the server replays the pending call with the amount it recorded.
      switch (action.pending) {
        case 'capture':
          return { path: `${base}/deposit/capture`, body: { reason: action.reason ?? 'completed' } };
        case 'void':
          return { path: `${base}/deposit/void` };
        case 'reauthorize':
          return { path: `${base}/deposit/reauthorize` };
        case 'refund':
          return { path: `${base}/deposit/refund`, body: {} };
        default:
          return { path: `${base}/wallet/charge`, body: {} };
      }
  }
}

/** 1000 -> "10.00", for an amount field's starting value. */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

export type ParsedAmount = { ok: true; cents: number } | { ok: false; message: string };

const AMOUNT_HELP = 'Write the amount like 4.00 or 4,00.';

/**
 * A dollar amount typed by a person, as cents, never through floating point. Both "4.50" and "4,50"
 * work, as do thousands separators when the decimal mark is unambiguous ("1,234.50", "1.234,50").
 * A lone separator followed by exactly three digits ("4,500", "1.234") could mean either, so it is
 * refused rather than guessed.
 */
export function parseDollars(input: string, maxCents: number): ParsedAmount {
  const text = input.trim().replace(/^\$\s*/, '').replace(/\s*(USD)?$/i, '');
  const fail = (message: string): ParsedAmount => ({ ok: false, message });
  if (!/^[\d.,]+$/.test(text) || !/\d/.test(text)) return fail(AMOUNT_HELP);

  let whole: string;
  let fraction = '';
  const lastDot = text.lastIndexOf('.');
  const lastComma = text.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    // Both marks: the last one is the decimal mark, the other groups thousands.
    const decimal = lastDot > lastComma ? '.' : ',';
    const group = decimal === '.' ? ',' : '.';
    const [head, tail, ...rest] = text.split(decimal);
    if (rest.length > 0 || !/^\d{1,2}$/.test(tail) || !new RegExp(`^\\d{1,3}(\\${group}\\d{3})+$`).test(head)) return fail(AMOUNT_HELP);
    whole = head.split(group).join('');
    fraction = tail;
  } else if (lastDot !== -1 || lastComma !== -1) {
    const mark = lastDot !== -1 ? '.' : ',';
    const parts = text.split(mark);
    if (parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d{1,2}$/.test(parts[1])) {
      whole = parts[0];
      fraction = parts[1];
    } else if (parts.every((part, i) => (i === 0 ? /^\d{1,3}$/.test(part) : /^\d{3}$/.test(part)))) {
      return fail(`"${input.trim()}" could mean two different amounts. ${AMOUNT_HELP}`);
    } else {
      return fail(AMOUNT_HELP);
    }
  } else {
    whole = text;
  }

  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return fail(`The amount can be at most ${dollars(maxCents)}.`);
  if (cents < 1) return fail('The amount must be at least $0.01.');
  if (cents > maxCents) return fail(`The amount can be at most ${dollars(maxCents)}.`);
  return { ok: true, cents };
}

/**
 * State of the booking panel. Requests run per booking: every choice, request and message carries the
 * booking it belongs to, so switching to another booking while PayPal answers never shows one
 * customer's result on another's panel.
 */
export interface PanelState {
  choice?: { bookingId: string; kind: BoardAction['kind']; amount: string };
  /** Bookings with a request in flight. */
  sending: string[];
  /** The latest outcome per booking. */
  messages: Record<string, { kind: 'done' | 'error'; text: string }>;
}

export type PanelEvent =
  | { type: 'choose'; bookingId: string; action: BoardAction }
  | { type: 'amount'; value: string }
  | { type: 'cancel' }
  | { type: 'start'; bookingId: string }
  | { type: 'finish'; bookingId: string; ok: boolean; text: string };

export const PANEL_START: PanelState = { sending: [], messages: {} };

export function panelReducer(state: PanelState, event: PanelEvent): PanelState {
  switch (event.type) {
    case 'choose': {
      const { [event.bookingId]: _old, ...messages } = state.messages;
      const amount = 'maxCents' in event.action ? centsToInput(event.action.maxCents) : '';
      return { ...state, messages, choice: { bookingId: event.bookingId, kind: event.action.kind, amount } };
    }
    case 'amount':
      return state.choice ? { ...state, choice: { ...state.choice, amount: event.value } } : state;
    case 'cancel':
      return { ...state, choice: undefined };
    case 'start': {
      const { [event.bookingId]: _old, ...messages } = state.messages;
      return { ...state, messages, sending: [...state.sending, event.bookingId] };
    }
    case 'finish':
      return {
        sending: state.sending.filter((id) => id !== event.bookingId),
        // A choice for another booking, made meanwhile, stays open.
        choice: event.ok && state.choice?.bookingId === event.bookingId ? undefined : state.choice,
        messages: { ...state.messages, [event.bookingId]: { kind: event.ok ? 'done' : 'error', text: event.text } },
      };
  }
}

/**
 * What the panel shows for one booking, worked out from its current state: a choice the booking no
 * longer allows (a webhook or the copilot changed it meanwhile) is dropped, and amount limits follow
 * the booking as it is now.
 */
export function panelView(state: PanelState, booking: BoardBooking, now: Date = new Date()) {
  const actions = bookingActions(booking, now);
  const chosen = state.choice?.bookingId === booking.id ? actions.find((a) => a.kind === state.choice!.kind) : undefined;
  const amount = chosen ? state.choice!.amount : '';
  const parsed = chosen && 'maxCents' in chosen ? parseDollars(amount, chosen.maxCents) : undefined;
  return {
    actions,
    chosen,
    amount,
    parsed,
    sending: state.sending.includes(booking.id),
    message: state.messages[booking.id],
    expired: replayExpired(booking, now),
  };
}

/** A money call with an unconfirmed result outranks the status: the money may already have moved. */
function moneyOf(booking: BoardBooking): { state: MoneyState; label: string } {
  if (booking.hold?.pendingAction || booking.hold?.authorizeOutcomeUnknown) return { state: 'review', label: 'Confirming with PayPal' };
  if (booking.status === 'cancelled' && !booking.hold?.authorizationId) return { state: 'released', label: 'Cancelled' };
  return MONEY[booking.status];
}

function amountFor(booking: BoardBooking): string {
  if (booking.status === 'cancelled' && !booking.hold?.authorizationId) return '';
  if (booking.status === 'refunded') return dollars(refundedSoFar(booking));
  // A part refund shows what the business kept.
  if (booking.status === 'partially_refunded') return dollars(refundable(booking));
  return dollars(booking.hold?.capture?.amountCents ?? booking.deposit.cents);
}

function endOf(startsAt: string, service: BoardService | undefined): string {
  const minutes = service?.durationMinutes ?? 60;
  return new Date(Date.parse(startsAt) + minutes * 60_000).toISOString();
}

export function bookingEvent(booking: BoardBooking, services: BoardService[]): BoardEvent {
  const service = services.find((s) => s.id === booking.serviceId);
  const money = moneyOf(booking);
  return {
    id: booking.id,
    resourceId: booking.staffId ?? UNASSIGNED,
    startDate: booking.startsAt,
    endDate: endOf(booking.startsAt, service),
    name: booking.customerName,
    serviceName: service?.name ?? booking.serviceId,
    moneyState: money.state,
    moneyLabel: money.label,
    amount: amountFor(booking),
    viaAgent: booking.source === 'agent',
    draggable: false,
    resizable: false,
  };
}

export type PlanStep =
  | { type: 'move_booking'; bookingId: string; staffId?: string; startsAt?: string; why: string }
  | { type: 'capture_deposit'; bookingId: string; reason: 'completed' | 'no_show'; amountCents?: number; why: string }
  | { type: 'void_deposit'; bookingId: string; why: string }
  | { type: 'reauthorize_deposit'; bookingId: string; why: string }
  | { type: 'refund_deposit'; bookingId: string; amountCents?: number; why: string }
  | { type: 'charge_saved_wallet'; bookingId: string; amountCents?: number; why: string }
  | { type: 'run_payouts'; day: string; why: string };

export interface StepResult {
  index: number;
  type: PlanStep['type'];
  outcome: 'done' | 'failed' | 'skipped';
  paypal?: Record<string, string>;
  error?: { code: string; message: string };
}

export interface Plan {
  id: string;
  request: string;
  summary: string;
  steps: PlanStep[];
  status: 'proposed' | 'executing' | 'executed' | 'failed' | 'rejected';
  createdAt: string;
  results?: StepResult[];
}

export interface AuditEntry {
  at: string;
  planId: string;
  stepIndex: number;
  action: PlanStep['type'];
  bookingId?: string;
  day?: string;
  amountCents?: number;
  outcome: 'done' | 'failed';
  why: string;
  paypal?: Record<string, string>;
  error?: { code: string; message: string };
}

/** The owner-facing wording of a plan step. */
export function stepTitle(step: PlanStep, bookings: BoardBooking[], staff: BoardStaff[]): string {
  if (step.type === 'run_payouts') return `Pay staff for ${step.day}`;
  const booking = bookings.find((b) => b.id === step.bookingId);
  const who = booking?.customerName ?? 'Unknown booking';
  const deposit = booking?.deposit.cents;
  const amount = (cents: number | undefined) => (cents === undefined ? '' : ` ${dollars(cents)}`);
  switch (step.type) {
    case 'move_booking': {
      const to = staff.find((s) => s.id === step.staffId)?.name;
      return to ? `Move ${who} to ${to}` : `Move ${who}`;
    }
    case 'capture_deposit':
      return `${step.reason === 'no_show' ? 'Charge no-show fee' : 'Capture'}${amount(step.amountCents ?? deposit)} · ${who}`;
    case 'void_deposit':
      return `Release hold · ${who}`;
    case 'reauthorize_deposit':
      return `Renew hold · ${who}`;
    case 'refund_deposit':
      return `Refund${amount(step.amountCents ?? (booking && refundable(booking)))} · ${who}`;
    case 'charge_saved_wallet':
      return `Charge saved wallet${amount(step.amountCents ?? (booking && walletRemainder(booking)))} · ${who}`;
  }
}

function stepNote(step: PlanStep, bookings: BoardBooking[]): string | undefined {
  const booking = 'bookingId' in step ? bookings.find((b) => b.id === step.bookingId) : undefined;
  const amount = (cents: number | undefined) => (cents === undefined ? '' : ` ${dollars(cents)}`);
  switch (step.type) {
    case 'capture_deposit':
      return `Will ${step.reason === 'no_show' ? 'charge' : 'capture'}${amount(step.amountCents ?? booking?.deposit.cents)}`;
    case 'void_deposit':
      return 'Will release hold';
    case 'reauthorize_deposit':
      return 'Will renew hold';
    case 'refund_deposit':
      return `Will refund${amount(step.amountCents ?? (booking && refundable(booking)))}`;
    case 'charge_saved_wallet':
      return `Will charge wallet${amount(step.amountCents ?? (booking && walletRemainder(booking)))}`;
    default:
      return undefined;
  }
}

/**
 * The events to draw: every booking, plus the preview of an open plan. A moved booking leaves a faded
 * original and a dashed ghost at its destination; a money step adds a note to the booking. Only a
 * proposed plan previews: once it has run, the real bookings already show the result.
 */
export function boardEvents(bookings: BoardBooking[], services: BoardService[], plan?: Plan): BoardEvent[] {
  const events = new Map(bookings.map((booking) => [booking.id, bookingEvent(booking, services)]));
  if (plan?.status !== 'proposed') return [...events.values()];

  const service = (booking: BoardBooking) => services.find((s) => s.id === booking.serviceId);
  const ghosts = new Map<string, BoardEvent>();
  for (const step of plan.steps) {
    if (!('bookingId' in step)) continue;
    const event = events.get(step.bookingId);
    const booking = bookings.find((b) => b.id === step.bookingId);
    if (!event || !booking) continue;

    if (step.type === 'move_booking') {
      // A second move of the same booking starts from where the first would put it.
      const from = ghosts.get(booking.id) ?? event;
      const startDate = step.startsAt ?? from.startDate;
      ghosts.set(booking.id, {
        ...event,
        id: `ghost-${booking.id}`,
        resourceId: step.staffId ?? from.resourceId,
        startDate,
        endDate: endOf(startDate, service(booking)),
        ghost: true,
        planNote: undefined,
      });
      event.movingAway = true;
      continue;
    }
    const note = stepNote(step, bookings);
    if (note) event.planNote = event.planNote ? `${event.planNote}, ${note.toLowerCase()}` : note;
  }
  // The money note also belongs on the ghost: that is where the owner's eye goes.
  for (const [id, ghost] of ghosts) ghost.planNote = events.get(id)?.planNote;
  return [...events.values(), ...ghosts.values()];
}

/** Staff rows: the team, plus "Unassigned" only while some booking needs it. */
export function boardResources(staff: BoardStaff[], events: BoardEvent[]): BoardStaff[] {
  return events.some((e) => e.resourceId === UNASSIGNED) ? [...staff, { id: UNASSIGNED, name: 'Unassigned' }] : staff;
}

/** Replaces the booking in the list, or adds it (a new booking arrived on the live feed). */
export function upsertBooking(bookings: BoardBooking[], booking: BoardBooking): BoardBooking[] {
  const at = bookings.findIndex((b) => b.id === booking.id);
  if (at === -1) return [...bookings, booking];
  const next = [...bookings];
  next[at] = booking;
  return next;
}

/** "2026-11-02" as today's date in the business time zone. */
export function dayInZone(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * An instant as the wall-clock time in `timeZone`, with no offset ("2026-10-31T10:00:00"). The scheduler
 * shows dates as local time, so this is what makes a board read the same in any viewer's browser.
 */
export function wallClock(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

/** The day a proposed plan is about, so its preview lands on screen: where its first step acts. */
export function planDay(plan: Plan, bookings: BoardBooking[], timeZone: string): string | undefined {
  for (const step of plan.steps) {
    if (!('bookingId' in step)) continue;
    const startsAt = (step.type === 'move_booking' ? step.startsAt : undefined) ?? bookings.find((b) => b.id === step.bookingId)?.startsAt;
    if (startsAt) return dayInZone(new Date(startsAt), timeZone);
  }
  return undefined;
}

const OPEN_HOUR = 8;
const CLOSE_HOUR = 20;

/** The hours to show for a day: the working day, stretched to fit any event outside it. */
export function dayHours(events: BoardEvent[], day: string, timeZone: string): { open: number; close: number } {
  let open = OPEN_HOUR;
  let close = CLOSE_HOUR;
  for (const event of events) {
    const start = wallClock(event.startDate, timeZone);
    const end = wallClock(event.endDate, timeZone);
    if (start.slice(0, 10) === day) open = Math.min(open, Number(start.slice(11, 13)));
    if (end.slice(0, 10) === day) close = Math.max(close, Math.ceil(Number(end.slice(11, 13)) + Number(end.slice(14, 16)) / 60));
    // Running past midnight: the day shows through to its end.
    else if (start.slice(0, 10) === day) close = 24;
  }
  return { open, close };
}

export function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** The next day with a booking on it after `day`, for jumping past empty days. */
export function nextBookedDay(bookings: BoardBooking[], day: string, timeZone: string): string | undefined {
  return bookings
    .filter((b) => b.status !== 'cancelled')
    .map((b) => dayInZone(new Date(b.startsAt), timeZone))
    .filter((d) => d > day)
    .sort()[0];
}

export interface SseMessage {
  event: string;
  data: string;
}

/** One message from the live feed applied to the board. */
export function applyLiveMessage(board: BoardData, message: SseMessage): BoardData {
  if (message.event === 'booking') return { ...board, bookings: upsertBooking(board.bookings, JSON.parse(message.data) as BoardBooking) };
  if (message.event === 'storage') return { ...board, unsavedWrites: (JSON.parse(message.data) as { unsavedWrites: number }).unsavedWrites };
  return board;
}

/**
 * Incremental Server-Sent Events parser. EventSource can't send the Authorization header, so the board
 * reads the stream with fetch(), and a chunk can end anywhere, even mid-line.
 */
export function createSseParser() {
  let buffer = '';
  return (chunk: string): SseMessage[] => {
    buffer += chunk;
    const messages: SseMessage[] = [];
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length > 0) messages.push({ event, data: data.join('\n') });
    }
    return messages;
  };
}
