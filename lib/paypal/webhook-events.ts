import 'server-only';
import {
  AuthorizationStatus,
  CaptureStatus,
  RefundStatus,
  type CapturedPayment,
  type PaymentAuthorization,
  type PaymentsController,
  type Refund,
} from '@paypal/paypal-server-sdk';
import { withBookingLock } from '@/lib/booking/locks';
import type { Booking, BookingStatus, BookingStore, DepositHold } from '@/lib/booking/store';
import { parseCents, refundedCents } from './deposit-actions';
import { authorizeDepositReporting, DepositError, type DepositOrders } from './deposits';
import { describePayPalError, describeTransportError, isNetworkError, sanitizeError } from './errors';
import { WebhookRetryableError } from './webhook-signature';

/** The body was signed by PayPal but isn't a webhook event we can read. Answer 400. */
export class WebhookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookPayloadError';
  }
}

export interface WebhookEvent {
  id: string;
  eventType: string;
  resource: Record<string, unknown>;
}

export interface WebhookOutcome {
  result: 'updated' | 'unchanged' | 'ignored' | 'duplicate';
  bookingId?: string;
  reason?: string;
}

/** Follow-up reads use the Server SDK; the event payload is only a pointer to what changed. */
export interface WebhookPayPal {
  orders: DepositOrders;
  payments: Pick<PaymentsController, 'getAuthorizedPayment' | 'getCapturedPayment' | 'getRefund'>;
}

export function parseWebhookEvent(rawBody: Buffer): WebhookEvent {
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new WebhookPayloadError('Webhook body is not JSON.');
  }
  const event = body as { id?: unknown; event_type?: unknown; resource?: unknown };
  if (typeof event?.id !== 'string' || typeof event.event_type !== 'string') {
    throw new WebhookPayloadError('Webhook body has no event id or type.');
  }
  const resource =
    typeof event.resource === 'object' && event.resource !== null
      ? (event.resource as Record<string, unknown>)
      : {};
  return { id: event.id, eventType: event.event_type, resource };
}

const AUTHORIZATION_EVENTS = new Set([
  'PAYMENT.AUTHORIZATION.CREATED',
  'PAYMENT.AUTHORIZATION.VOIDED',
]);
const CAPTURE_EVENTS = new Set([
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.DECLINED',
  'PAYMENT.CAPTURE.PENDING',
]);

/**
 * Applies one PayPal event to the booking it belongs to. The payload only says which PayPal object
 * changed: handlers read that object with the Server SDK while holding the booking lock and act on
 * what PayPal says now, so redelivered or out-of-order events can't move a booking backwards.
 */
export async function handleWebhookEvent(
  paypal: WebhookPayPal,
  store: BookingStore,
  event: WebhookEvent,
  now: Date = new Date(),
): Promise<WebhookOutcome> {
  const resourceId = typeof event.resource.id === 'string' ? event.resource.id : undefined;
  if (!resourceId) return { result: 'ignored', reason: 'event has no resource id' };

  if (event.eventType === 'CHECKOUT.ORDER.APPROVED') {
    return onOrderApproved(paypal, store, event.resource, resourceId, now);
  }
  if (AUTHORIZATION_EVENTS.has(event.eventType)) {
    return withFreshRead(
      store,
      'authorization read',
      () => paypal.payments.getAuthorizedPayment({ authorizationId: resourceId }),
      (auth, booking) => applyAuthorization(store, booking, auth, now),
    );
  }
  if (CAPTURE_EVENTS.has(event.eventType)) {
    return withFreshRead(
      store,
      'capture read',
      () => paypal.payments.getCapturedPayment({ captureId: resourceId }),
      (capture, booking) => applyCapture(store, booking, capture, now),
    );
  }
  if (event.eventType === 'PAYMENT.CAPTURE.REFUNDED') {
    return withFreshRead(
      store,
      'refund read',
      () => paypal.payments.getRefund({ refundId: resourceId }),
      (refund, booking) => applyRefund(store, booking, refund, now),
    );
  }
  return { result: 'ignored', reason: `event type ${event.eventType} is not handled` };
}

/**
 * A GET whose failure decides what PayPal should do next: 404 means the object isn't ours (ignore
 * the event); anything transient becomes a 503 so PayPal redelivers.
 */
async function readPayPal<T>(label: string, read: () => Promise<{ result: T }>): Promise<T | undefined> {
  try {
    return (await read()).result;
  } catch (err) {
    const failure = describePayPalError(err);
    if (failure?.status === 404) return undefined;
    if (failure) {
      console.error(`[webhook] ${label} failed`, { status: failure.status, debugId: failure.debugId });
      throw new WebhookRetryableError(`PayPal answered HTTP ${failure.status} to ${label}.`);
    }
    if (isNetworkError(err)) {
      throw new WebhookRetryableError(`Could not reach PayPal for ${label}: ${describeTransportError(err)}`);
    }
    throw sanitizeError(err, `Webhook ${label}`);
  }
}

/**
 * Reads the PayPal object once to learn its booking (every SlotKeeper authorization, capture and
 * refund carries the booking id as custom_id, inherited from the order), then reads it again under
 * the booking lock and applies that fresh copy. The second read is what makes ordering safe: a
 * handler that waited for the lock still sees PayPal's latest state, not the one it saw before.
 */
async function withFreshRead<T extends { id?: string; customId?: string }>(
  store: BookingStore,
  label: string,
  read: () => Promise<{ result: T }>,
  apply: (fresh: T, booking: Booking & { hold: DepositHold }) => WebhookOutcome,
): Promise<WebhookOutcome> {
  const first = await readPayPal(label, read);
  const bookingId = first?.customId;
  if (!first?.id || !bookingId) return { result: 'ignored', reason: `${label}: not found or not ours` };

  return withBookingLock(
    bookingId,
    async (): Promise<WebhookOutcome> => {
      const booking = store.get(bookingId);
      if (!booking?.hold) return { result: 'ignored', reason: 'no booking with a hold for this object' };
      const fresh = await readPayPal(label, read);
      if (!fresh?.id) return { result: 'ignored', bookingId, reason: `${label}: no longer found` };
      return apply(fresh, booking as Booking & { hold: DepositHold });
    },
    'wait',
  );
}

/**
 * The customer approved in PayPal. Normally the browser authorizes right away; if they closed the
 * tab first, this completes the hold. Both paths share the booking lock, so the loser just stops.
 */
async function onOrderApproved(
  paypal: WebhookPayPal,
  store: BookingStore,
  resource: Record<string, unknown>,
  orderId: string,
  now: Date,
): Promise<WebhookOutcome> {
  const unit = Array.isArray(resource.purchase_units) ? (resource.purchase_units[0] as Record<string, unknown>) : {};
  const bookingId = typeof unit?.custom_id === 'string' ? unit.custom_id : undefined;
  const booking = bookingId ? store.get(bookingId) : undefined;
  if (!booking) return { result: 'ignored', reason: 'no booking for this order' };
  if (booking.status !== 'awaiting_deposit' || booking.hold?.paypalOrderId !== orderId) {
    return { result: 'unchanged', bookingId: booking.id, reason: 'deposit already handled' };
  }
  try {
    const { alreadyHeld } = await authorizeDepositReporting(paypal.orders, store, booking.id, orderId, now);
    return alreadyHeld
      ? { result: 'unchanged', bookingId: booking.id, reason: 'browser already placed the hold' }
      : { result: 'updated', bookingId: booking.id };
  } catch (err) {
    if (!(err instanceof DepositError)) throw err;
    if (err.httpStatus >= 500) throw new WebhookRetryableError(`Authorizing from the webhook failed: ${err.message}`);
    // A definite answer (already held, declined, not approved...): the booking already shows it.
    return { result: 'unchanged', bookingId: booking.id, reason: err.code };
  }
}

function save(store: BookingStore, booking: Booking, status: BookingStatus, hold: Partial<DepositHold>): WebhookOutcome {
  store.save({ ...booking, status, hold: { ...booking.hold!, ...hold } });
  return { result: 'updated', bookingId: booking.id };
}

const OPEN_HOLD: BookingStatus[] = ['deposit_held', 'deposit_pending', 'deposit_needs_review'];

function applyAuthorization(
  store: BookingStore,
  booking: Booking & { hold: DepositHold },
  auth: PaymentAuthorization,
  now: Date,
): WebhookOutcome {
  const hold = booking.hold;
  const bookingId = booking.id;
  const status = auth.status;

  if (hold.authorizationId !== auth.id) {
    // A staff reauthorization whose answer we never saw: PayPal's new authorization for this
    // booking is its result (old ids are listed, so a late event for one can't be adopted).
    const pending = hold.pendingAction?.kind === 'reauthorize' ? hold.pendingAction : undefined;
    const replaced = hold.previousAuthorizationIds?.includes(auth.id!);
    const usable = status === AuthorizationStatus.Created || status === AuthorizationStatus.Pending;
    if (pending && !replaced && usable && !hold.capture) {
      const matches = parseCents(auth.amount?.value) === pending.amountCents;
      if (!matches) console.error('[webhook] reauthorized amount differs; needs review', { bookingId });
      const next: BookingStatus = !matches
        ? 'deposit_needs_review'
        : status === AuthorizationStatus.Created
          ? 'deposit_held'
          : 'deposit_pending';
      return save(store, booking, next, {
        authorizationId: auth.id,
        authorizationStatus: status,
        expiresAt: auth.expirationTime,
        previousAuthorizationIds: [...(hold.previousAuthorizationIds ?? []), hold.authorizationId!],
        heldAt: now.toISOString(),
        pendingAction: undefined,
      });
    }
    return { result: 'ignored', bookingId, reason: 'not the current authorization' };
  }

  const open = OPEN_HOLD.includes(booking.status) && !hold.capture;
  if (status === AuthorizationStatus.Created && booking.status === 'deposit_pending') {
    return save(store, booking, 'deposit_held', {
      authorizationStatus: status,
      expiresAt: auth.expirationTime ?? hold.expiresAt,
    });
  }
  if (status === AuthorizationStatus.Voided && open) {
    // Voided outside a staff action (PayPal dashboard), or a void whose answer we never saw.
    const settled = hold.pendingAction?.kind === 'void' ? { pendingAction: undefined } : {};
    return save(store, booking, 'cancelled', { authorizationStatus: status, voidedAt: now.toISOString(), ...settled });
  }
  // EXPIRED is a documented wire value that the SDK's enum (2.5.0) doesn't list.
  if ((status === AuthorizationStatus.Denied || String(status) === 'EXPIRED') && open) {
    console.error('[webhook] authorization no longer usable; needs review', { bookingId, status });
    return save(store, booking, 'deposit_needs_review', { authorizationStatus: status });
  }
  return { result: 'unchanged', bookingId };
}

function applyCapture(
  store: BookingStore,
  booking: Booking & { hold: DepositHold },
  capture: CapturedPayment,
  now: Date,
): WebhookOutcome {
  const hold = booking.hold;
  const bookingId = booking.id;
  const failed = capture.status === CaptureStatus.Declined || capture.status === CaptureStatus.Failed;
  const took = capture.status === CaptureStatus.Completed || capture.status === CaptureStatus.Pending;
  const cents = parseCents(capture.amount?.value);

  // Our own capture: PayPal finished processing it (e.g. PENDING -> COMPLETED, or declined).
  const recorded = hold.capture;
  if (recorded && recorded.captureId === capture.id) {
    if (recorded.status === capture.status) return { result: 'unchanged', bookingId };
    const record = { ...recorded, status: capture.status ?? recorded.status };
    if (failed) {
      console.error('[webhook] capture declined after being recorded; needs review', { bookingId });
      return save(store, booking, 'deposit_needs_review', { capture: record });
    }
    return save(store, booking, booking.status, { capture: record });
  }
  if (recorded || capture.supplementaryData?.relatedIds?.authorizationId !== hold.authorizationId) {
    return { result: 'ignored', bookingId, reason: 'capture is not for the current hold' };
  }

  // A staff capture whose answer we never saw: the webhook tells us how it ended.
  const pending = hold.pendingAction?.kind === 'capture' ? hold.pendingAction : undefined;
  if (pending && failed) {
    return save(store, booking, booking.status, {
      pendingAction: undefined,
      actionAttempts: { ...hold.actionAttempts, capture: (hold.actionAttempts?.capture ?? 1) + 1 },
    });
  }
  if (pending && took) {
    const settled: BookingStatus = pending.reason === 'no_show' ? 'no_show_charged' : 'completed';
    return save(store, booking, cents === pending.amountCents ? settled : 'deposit_needs_review', {
      capture: {
        captureId: capture.id!,
        amountCents: cents ?? pending.amountCents!,
        status: capture.status!,
        reason: pending.reason ?? 'completed',
        capturedAt: now.toISOString(),
      },
      pendingAction: undefined,
    });
  }
  if (took && cents !== undefined) {
    // Captured outside SlotKeeper (e.g. the PayPal dashboard). Record it so void is refused and
    // later refunds of it can be matched, and let staff reconcile the booking.
    console.error('[webhook] capture made outside the app; needs review', { bookingId, captureId: capture.id });
    return save(store, booking, 'deposit_needs_review', {
      capture: {
        captureId: capture.id!,
        amountCents: cents,
        status: capture.status!,
        reason: 'external',
        capturedAt: now.toISOString(),
      },
    });
  }
  return { result: 'unchanged', bookingId };
}

const CAPTURED: BookingStatus[] = ['completed', 'no_show_charged', 'partially_refunded', 'refunded'];

function applyRefund(
  store: BookingStore,
  booking: Booking & { hold: DepositHold },
  refund: Refund,
  now: Date,
): WebhookOutcome {
  const hold = booking.hold;
  const bookingId = booking.id;
  const up = refund.links?.find((link) => link.rel === 'up')?.href;
  const captureId = up?.match(/\/captures\/([^/?#]+)/)?.[1];
  if (!hold.capture || hold.capture.captureId !== captureId) {
    return { result: 'ignored', bookingId, reason: 'refund is not for this booking\'s capture' };
  }
  const status = refund.status ?? RefundStatus.Pending;
  const cents = parseCents(refund.amount?.value);
  const refunds = [...(hold.refunds ?? [])];
  const known = refunds.findIndex((r) => r.refundId === refund.id);
  let changes: Partial<DepositHold> = {};
  let mismatch = false;

  if (known >= 0) {
    if (refunds[known].status === status) return { result: 'unchanged', bookingId };
    refunds[known] = { ...refunds[known], status };
  } else if (cents === undefined) {
    throw new WebhookRetryableError('Refund amount could not be read.');
  } else {
    refunds.push({ refundId: refund.id!, amountCents: cents, status, refundedAt: now.toISOString() });
    // Only the exact refund the pending staff action sent can settle it: its invoice id carries
    // the same `<sequence>-<attempt>` as its PayPal-Request-Id. A dashboard refund, or an older
    // refund of ours, leaves the pending action open.
    const pending = hold.pendingAction?.kind === 'refund' ? hold.pendingAction : undefined;
    const requestPrefix = `slotkeeper-refund-${hold.capture.captureId}-`;
    const expectedInvoice = pending?.requestId.startsWith(requestPrefix)
      ? `${bookingId}-refund-${pending.requestId.slice(requestPrefix.length)}`
      : undefined;
    if (pending && expectedInvoice && refund.invoiceId === expectedInvoice) {
      changes = { pendingAction: undefined };
      mismatch = cents !== pending.amountCents;
    }
  }

  let next = booking.status;
  if (mismatch) {
    next = 'deposit_needs_review';
  } else if (CAPTURED.includes(booking.status)) {
    const total = refundedCents({ ...hold, refunds });
    next =
      total >= hold.capture.amountCents
        ? 'refunded'
        : total > 0
          ? 'partially_refunded'
          : hold.capture.reason === 'no_show'
            ? 'no_show_charged'
            : 'completed';
  }
  return save(store, booking, next, { ...changes, refunds });
}

// Event ids already applied, so a redelivery is acknowledged without work. Handlers are idempotent
// anyway (they re-read PayPal); this just saves the PayPal calls. Process-local and bounded.
const seen = globalThis as typeof globalThis & {
  __slotkeeperWebhookEvents?: { done: Set<string>; running: Set<string> };
};
const MAX_REMEMBERED_EVENTS = 5_000;

export async function processWebhookOnce(
  eventId: string,
  run: () => Promise<WebhookOutcome>,
): Promise<WebhookOutcome> {
  const state = (seen.__slotkeeperWebhookEvents ??= { done: new Set(), running: new Set() });
  if (state.done.has(eventId)) return { result: 'duplicate' };
  if (state.running.has(eventId)) {
    // Same event delivered twice at once: let PayPal retry the second copy later.
    throw new WebhookRetryableError('This event is already being processed.');
  }
  state.running.add(eventId);
  try {
    const outcome = await run();
    // Only remember events that finished; a failed one must be processed again on redelivery.
    if (state.done.size >= MAX_REMEMBERED_EVENTS) state.done.delete(state.done.values().next().value!);
    state.done.add(eventId);
    return outcome;
  } finally {
    state.running.delete(eventId);
  }
}
