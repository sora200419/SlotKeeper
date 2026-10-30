import 'server-only';
import {
  ArgumentsValidationError,
  AuthorizationStatus,
  CaptureStatus,
  CheckoutPaymentIntent,
  OrderStatus,
  PaymentInitiator,
  RefundStatus,
  StoredPaymentSourceUsageType,
  UsagePattern,
  type OrdersController,
  type PaymentsController,
  type VaultController,
} from '@paypal/paypal-server-sdk';
import { formatAmount, type Money } from '@/lib/booking/catalog';
import { withBookingLock } from '@/lib/booking/locks';
import type {
  Booking,
  BookingStatus,
  BookingStore,
  DepositHold,
  MoneyActionKind,
} from '@/lib/booking/store';
import { DepositError } from './deposits';
import {
  describePayPalError,
  describeTransportError,
  isNetworkError,
  sanitizeError,
  type PayPalFailure,
} from './errors';

/** The Payments operations the staff money actions use; tests pass a real controller over a stub adapter. */
export type DepositPayments = Pick<
  PaymentsController,
  'captureAuthorizedPayment' | 'voidPayment' | 'reauthorizePayment' | 'refundCapturedPayment'
>;

type CaptureReason = 'completed' | 'no_show';
type HeldBooking = Booking & { hold: DepositHold };

interface ActionParams {
  amountCents?: number;
  reason?: CaptureReason;
}

const EXPIRED_ISSUES = new Set(['AUTHORIZATION_EXPIRED']);
const VOIDED_ISSUES = new Set(['AUTHORIZATION_VOIDED', 'PREVIOUSLY_VOIDED']);
const ALREADY_CAPTURED_ISSUES = new Set([
  'AUTHORIZATION_ALREADY_CAPTURED',
  'PREVIOUSLY_CAPTURED',
  'MAX_CAPTURE_COUNT_EXCEEDED',
]);
const DECLINE_ISSUES = new Set([
  'INSTRUMENT_DECLINED',
  'TRANSACTION_REFUSED',
  'PAYER_ACTION_REQUIRED',
  // Seen from the sandbox via PayPal-Mock-Response (npm run test:sandbox).
  'PAYER_CANNOT_PAY',
  'AUTHORIZATION_DENIED',
  'REFUND_FAILED_INSUFFICIENT_FUNDS',
]);

function loadHeldBooking(store: BookingStore, bookingId: string): HeldBooking {
  const booking = store.get(bookingId);
  if (!booking) throw new DepositError('booking_not_found', 404, 'Booking not found.');
  if (!booking.hold?.authorizationId) {
    throw new DepositError('invalid_state', 409, 'This booking has no PayPal deposit hold.');
  }
  return booking as HeldBooking;
}

function toMoney(currency: Money['currency'], cents: number) {
  return { currencyCode: currency, value: formatAmount({ currency, cents }) };
}

/** PayPal amounts are decimal strings ("10.00"); parse back to cents without floats. */
export function parseCents(value: string | undefined): number | undefined {
  if (!value || !/^\d+(\.\d{1,2})?$/.test(value)) return undefined;
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

function requireStatus(booking: Booking, allowed: BookingStatus[], action: string): void {
  if (!allowed.includes(booking.status)) {
    throw new DepositError(
      'invalid_state',
      409,
      `Cannot ${action} a booking whose deposit is "${booking.status}".`,
    );
  }
}

function fromActionFailure(failure: PayPalFailure, action: string): DepositError {
  const issue = failure.issue;
  if (issue && EXPIRED_ISSUES.has(issue)) {
    return new DepositError(
      'authorization_expired',
      409,
      action === 'capture the deposit'
        ? 'The PayPal hold has expired. Reauthorize it first, or ask the customer to pay again.'
        : 'The PayPal hold has expired. Ask the customer to pay again if a deposit is still needed.',
      failure,
    );
  }
  if (issue && VOIDED_ISSUES.has(issue)) {
    return new DepositError('invalid_state', 409, 'The PayPal hold was already released.', failure);
  }
  if (issue && ALREADY_CAPTURED_ISSUES.has(issue)) {
    return new DepositError(
      'needs_review',
      409,
      'PayPal says this hold was already captured. Staff need to check it.',
      failure,
    );
  }
  if (issue && DECLINE_ISSUES.has(issue)) {
    return new DepositError('declined', 402, `PayPal declined the request to ${action}.`, failure);
  }
  return new DepositError(
    'paypal_error',
    failure.status >= 500 ? 502 : 422,
    `PayPal could not ${action} (HTTP ${failure.status}${issue ? `, ${issue}` : ''}).`,
    failure,
  );
}

interface MoneyAction<T> {
  kind: MoneyActionKind;
  /** The PayPal object the call acts on; part of the PayPal-Request-Id. */
  targetId: string;
  params: ActionParams;
  /** Human wording for logs and errors, e.g. "capture the deposit". */
  label: string;
  /** `attempt` is stable across replays of one logical call, so it can go into invoice ids. */
  call: (requestId: string, params: ActionParams, attempt: number) => Promise<T>;
  /** False when a 2xx body can't tell us what happened; the action is then treated as outcome-unknown. */
  isReadable: (result: T) => boolean;
}

/**
 * Runs one money call with a stable PayPal-Request-Id. Callers hold the booking lock.
 * - Definite 4xx answer: nothing happened; clear any pending action and bump the attempt so the next
 *   try isn't served PayPal's stored failure.
 * - Anything else (5xx, no response, unreadable 2xx): the money may have moved. Record the action as
 *   pending; until it is replayed with the same id and parameters, no other money call is allowed.
 */
async function runMoneyAction<T>(
  store: BookingStore,
  booking: HeldBooking,
  action: MoneyAction<T>,
  now: Date,
): Promise<{ result: T; params: ActionParams }> {
  const { kind, label } = action;
  const hold = booking.hold;
  const pending = hold.pendingAction;
  const attempt = hold.actionAttempts?.[kind] ?? 1;
  let requestId: string;
  let params = action.params;

  if (pending) {
    if (pending.kind !== kind) {
      throw new DepositError(
        'pending_action',
        409,
        `A ${pending.kind} is still being confirmed with PayPal. Retry that first.`,
      );
    }
    if (params.amountCents !== undefined && params.amountCents !== pending.amountCents) {
      throw new DepositError(
        'pending_action',
        409,
        `A ${kind} of ${pending.amountCents} cents is still being confirmed with PayPal. Retry it with the same amount.`,
      );
    }
    if (params.reason !== undefined && pending.reason !== undefined && params.reason !== pending.reason) {
      throw new DepositError(
        'pending_action',
        409,
        `A ${pending.reason} ${kind} is still being confirmed with PayPal. Retry it with the same reason.`,
      );
    }
    requestId = pending.requestId;
    params = { amountCents: pending.amountCents, reason: pending.reason ?? params.reason };
  } else {
    requestId = `slotkeeper-${kind}-${action.targetId}-${attempt}`;
  }

  const markUnknown = () =>
    store.save({
      ...booking,
      hold: {
        ...hold,
        pendingAction: {
          kind,
          requestId,
          amountCents: params.amountCents,
          reason: params.reason,
          since: pending?.since ?? now.toISOString(),
        },
      },
    });

  let result: T;
  try {
    result = await action.call(requestId, params, attempt);
  } catch (err) {
    if (err instanceof ArgumentsValidationError) {
      // The SDK refused the arguments before sending anything: a bug here, not an unknown outcome.
      console.error(`[paypal] ${label}: request not sent`, {
        bookingId: booking.id,
        error: sanitizeError(err, label).message,
      });
      throw sanitizeError(err, `Could not ${label}`);
    }
    const failure = describePayPalError(err);
    if (failure && failure.status < 500) {
      console.error(`[paypal] ${label} failed`, {
        bookingId: booking.id,
        status: failure.status,
        issue: failure.issue,
        debugId: failure.debugId,
      });
      const mapped = fromActionFailure(failure, label);
      store.save({
        ...booking,
        // PayPal disagrees with our record (e.g. already captured): staff must reconcile it.
        status: mapped.code === 'needs_review' ? 'deposit_needs_review' : booking.status,
        hold: {
          ...hold,
          pendingAction: undefined,
          actionAttempts: { ...hold.actionAttempts, [kind]: attempt + 1 },
        },
      });
      throw mapped;
    }
    markUnknown();
    if (failure) {
      console.error(`[paypal] ${label}: outcome unknown`, {
        bookingId: booking.id,
        status: failure.status,
        debugId: failure.debugId,
      });
      throw fromActionFailure(failure, label);
    }
    if (isNetworkError(err)) {
      console.error(`[paypal] ${label}: could not reach PayPal, outcome unknown`, {
        bookingId: booking.id,
        reason: describeTransportError(err),
      });
      throw new DepositError('network_error', 502, 'Could not reach PayPal. Please retry.');
    }
    console.error(`[paypal] ${label}: response could not be read, outcome unknown`, {
      bookingId: booking.id,
      error: sanitizeError(err, label).message,
    });
    throw new DepositError('paypal_error', 502, `PayPal's answer could not be read. Retry to ${label}.`);
  }

  if (!action.isReadable(result)) {
    markUnknown();
    console.error(`[paypal] ${label}: response is missing the result, outcome unknown`, {
      bookingId: booking.id,
    });
    throw new DepositError('paypal_error', 502, `PayPal's answer could not be read. Retry to ${label}.`);
  }
  return { result, params };
}

/** Saves the booking with the pending action cleared (the call's outcome is now known). */
function saveSettled(
  store: BookingStore,
  booking: HeldBooking,
  changes: Partial<Booking>,
  hold: Partial<DepositHold>,
): Booking {
  const updated: Booking = {
    ...booking,
    ...changes,
    hold: { ...booking.hold, ...hold, pendingAction: undefined },
  };
  store.save(updated);
  return updated;
}

/** After a definite non-success result: settle, and bump the attempt so a retry gets a fresh id. */
function saveFailedAttempt(store: BookingStore, booking: HeldBooking, kind: MoneyActionKind): void {
  saveSettled(store, booking, {}, {
    actionAttempts: {
      ...booking.hold.actionAttempts,
      [kind]: (booking.hold.actionAttempts?.[kind] ?? 1) + 1,
    },
  });
}

/**
 * Captures the held deposit: in full when the service was delivered, or a no-show fee (any amount up
 * to the deposit). `final_capture` releases whatever isn't captured back to the customer.
 * A PENDING capture is recorded like a completed one; the webhook step (prompt 4) settles it.
 */
export function captureDeposit(
  payments: DepositPayments,
  store: BookingStore,
  bookingId: string,
  request: { reason: CaptureReason; amountCents?: number },
  now: Date = new Date(),
): Promise<Booking> {
  return withBookingLock(bookingId, async () => {
    const booking = loadHeldBooking(store, bookingId);
    const replaying = booking.hold.pendingAction?.kind === 'capture';
    if (!replaying) {
      if (booking.status === 'deposit_pending') {
        throw new DepositError(
          'invalid_state',
          409,
          'PayPal is still reviewing this hold; it can be captured once PayPal approves it.',
        );
      }
      requireStatus(booking, ['deposit_held'], 'capture');
    }

    const depositCents = booking.deposit.cents;
    // A replay keeps the pending capture's amount; runMoneyAction refuses a different explicit one.
    let amountCents: number | undefined;
    if (replaying) {
      amountCents = request.amountCents;
    } else if (request.reason === 'completed') {
      if (request.amountCents !== undefined && request.amountCents !== depositCents) {
        throw new DepositError(
          'invalid_amount',
          400,
          'A completed booking captures the whole deposit; use reason "no_show" for a smaller fee.',
        );
      }
      amountCents = depositCents;
    } else {
      amountCents = request.amountCents ?? depositCents;
      if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > depositCents) {
        throw new DepositError(
          'invalid_amount',
          400,
          `The no-show fee must be a whole number of cents between 1 and ${depositCents}.`,
        );
      }
    }

    const authorizationId = booking.hold.authorizationId!;
    const { result: capture, params } = await runMoneyAction(
      store,
      booking,
      {
        kind: 'capture',
        targetId: authorizationId,
        params: { amountCents, reason: request.reason },
        label: 'capture the deposit',
        call: async (requestId, effective, attempt) =>
          (
            await payments.captureAuthorizedPayment({
              authorizationId,
              paypalRequestId: requestId,
              prefer: 'return=representation',
              body: {
                amount: toMoney(booking.deposit.currency, effective.amountCents!),
                finalCapture: true,
                invoiceId: `${booking.id}-capture-${attempt}`,
                noteToPayer:
                  effective.reason === 'no_show'
                    ? 'No-show fee for your missed appointment.'
                    : 'Deposit applied to your appointment.',
              },
            })
          ).result,
        isReadable: (result) => Boolean(result?.id),
      },
      now,
    );

    if (capture.status !== CaptureStatus.Completed && capture.status !== CaptureStatus.Pending) {
      console.error('[paypal] capture not completed', {
        bookingId,
        captureId: capture.id,
        status: capture.status,
      });
      saveFailedAttempt(store, booking, 'capture');
      throw new DepositError(
        'declined',
        402,
        `PayPal did not capture the deposit (${capture.status ?? 'no status'}).`,
      );
    }

    const record = {
      captureId: capture.id!,
      amountCents: params.amountCents!,
      status: capture.status,
      reason: params.reason!,
      capturedAt: now.toISOString(),
    };
    if (
      parseCents(capture.amount?.value) !== params.amountCents ||
      capture.amount?.currencyCode !== booking.deposit.currency
    ) {
      console.error('[paypal] captured amount differs from the request; needs review', {
        bookingId,
        captureId: capture.id,
      });
      saveSettled(store, booking, { status: 'deposit_needs_review' }, { capture: record });
      throw new DepositError(
        'amount_mismatch',
        502,
        'PayPal captured a different amount than requested. Staff will review it.',
      );
    }

    return saveSettled(
      store,
      booking,
      { status: params.reason === 'no_show' ? 'no_show_charged' : 'completed' },
      { capture: record },
    );
  });
}

/** Releases the hold (cancellation within policy). Voiding is free; refunds cost fees, so prefer this. */
export function voidDeposit(
  payments: DepositPayments,
  store: BookingStore,
  bookingId: string,
  now: Date = new Date(),
): Promise<Booking> {
  return withBookingLock(bookingId, async () => {
    const booking = loadHeldBooking(store, bookingId);
    if (booking.hold.pendingAction?.kind !== 'void') {
      if (booking.hold.capture) {
        throw new DepositError('invalid_state', 409, 'This deposit was captured; refund it instead.');
      }
      requireStatus(booking, ['deposit_held', 'deposit_pending', 'deposit_needs_review'], 'void');
    }

    const authorizationId = booking.hold.authorizationId!;
    const { result } = await runMoneyAction(
      store,
      booking,
      {
        kind: 'void',
        targetId: authorizationId,
        params: {},
        label: 'void the deposit hold',
        call: async (requestId) =>
          (
            await payments.voidPayment({
              authorizationId,
              paypalRequestId: requestId,
              prefer: 'return=representation',
            })
          ).result,
        // A 204 with no body is a successful void.
        isReadable: () => true,
      },
      now,
    );

    if (result && result.status !== undefined && result.status !== AuthorizationStatus.Voided) {
      console.error('[paypal] void returned an unexpected status; needs review', {
        bookingId,
        status: result.status,
      });
      saveSettled(store, booking, { status: 'deposit_needs_review' }, {});
      throw new DepositError(
        'needs_review',
        409,
        `PayPal reported the hold as ${result.status}. Staff will review it.`,
      );
    }

    return saveSettled(
      store,
      booking,
      { status: 'cancelled' },
      { authorizationStatus: AuthorizationStatus.Voided, voidedAt: now.toISOString() },
    );
  });
}

/**
 * Extends a hold past PayPal's 3-day honor period (allowed once, between days 4 and 29). PayPal
 * returns a new authorization id, which replaces the old one for later capture or void.
 * A PENDING reauthorization leaves the booking in deposit_pending until the webhook step (prompt 4).
 */
export function reauthorizeDeposit(
  payments: DepositPayments,
  store: BookingStore,
  bookingId: string,
  now: Date = new Date(),
): Promise<Booking> {
  return withBookingLock(bookingId, async () => {
    const booking = loadHeldBooking(store, bookingId);
    if (booking.hold.pendingAction?.kind !== 'reauthorize') {
      requireStatus(booking, ['deposit_held'], 'reauthorize');
    }

    const authorizationId = booking.hold.authorizationId!;
    const { result } = await runMoneyAction(
      store,
      booking,
      {
        kind: 'reauthorize',
        targetId: authorizationId,
        params: { amountCents: booking.deposit.cents },
        label: 'reauthorize the deposit hold',
        call: async (requestId) =>
          (
            await payments.reauthorizePayment({
              authorizationId,
              paypalRequestId: requestId,
              prefer: 'return=representation',
              body: { amount: toMoney(booking.deposit.currency, booking.deposit.cents) },
            })
          ).result,
        isReadable: (result) => Boolean(result?.id),
      },
      now,
    );

    // PayPal issued a new authorization either way; keep its id so staff can look it up.
    const replaced = {
      authorizationId: result.id,
      authorizationStatus: result.status,
      expiresAt: result.expirationTime,
      previousAuthorizationIds: [...(booking.hold.previousAuthorizationIds ?? []), authorizationId],
      heldAt: now.toISOString(),
    };
    if (result.status !== AuthorizationStatus.Created && result.status !== AuthorizationStatus.Pending) {
      console.error('[paypal] reauthorization not usable; needs review', {
        bookingId,
        authorizationId: result.id,
        status: result.status,
      });
      saveSettled(store, booking, { status: 'deposit_needs_review' }, replaced);
      throw new DepositError(
        'needs_review',
        409,
        `PayPal returned a reauthorization with status ${result.status ?? 'unknown'}. Staff will review it.`,
      );
    }

    return saveSettled(
      store,
      booking,
      { status: result.status === AuthorizationStatus.Created ? 'deposit_held' : 'deposit_pending' },
      replaced,
    );
  });
}

/** Money already refunded or still being refunded (failed/cancelled refunds don't count). */
export function refundedCents(hold: DepositHold): number {
  return (hold.refunds ?? [])
    .filter((r) => r.status !== RefundStatus.Failed && r.status !== RefundStatus.Cancelled)
    .reduce((sum, r) => sum + r.amountCents, 0);
}

/** Refunds part or all of a captured deposit back to the customer's PayPal account. */
export function refundDeposit(
  payments: DepositPayments,
  store: BookingStore,
  bookingId: string,
  request: { amountCents?: number },
  now: Date = new Date(),
): Promise<Booking> {
  return withBookingLock(bookingId, async () => {
    const booking = loadHeldBooking(store, bookingId);
    const capture = booking.hold.capture;
    if (!capture) {
      throw new DepositError(
        'invalid_state',
        409,
        'Nothing was captured, so there is nothing to refund. Void the hold instead.',
      );
    }
    const replaying = booking.hold.pendingAction?.kind === 'refund';

    // A replay keeps the pending refund's amount; runMoneyAction refuses a different explicit one.
    let amountCents: number | undefined;
    if (replaying) {
      amountCents = request.amountCents;
    } else {
      requireStatus(booking, ['completed', 'no_show_charged', 'partially_refunded'], 'refund');
      const refundable = capture.amountCents - refundedCents(booking.hold);
      amountCents = request.amountCents ?? refundable;
      if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > refundable) {
        throw new DepositError(
          'invalid_amount',
          400,
          `The refund must be a whole number of cents between 1 and ${refundable}.`,
        );
      }
    }

    const sequence = (booking.hold.refunds?.length ?? 0) + 1;
    const { result, params } = await runMoneyAction(
      store,
      booking,
      {
        kind: 'refund',
        targetId: `${capture.captureId}-${sequence}`,
        params: { amountCents },
        label: 'refund the deposit',
        call: async (requestId, effective, attempt) =>
          (
            await payments.refundCapturedPayment({
              captureId: capture.captureId,
              paypalRequestId: requestId,
              prefer: 'return=representation',
              body: {
                amount: toMoney(booking.deposit.currency, effective.amountCents!),
                invoiceId: `${booking.id}-refund-${sequence}-${attempt}`,
                // Lets the PAYMENT.CAPTURE.REFUNDED webhook find the booking directly.
                customId: booking.id,
                noteToPayer: 'Refund of your appointment deposit.',
              },
            })
          ).result,
        isReadable: (result) => Boolean(result?.id),
      },
      now,
    );

    if (result.status === RefundStatus.Failed || result.status === RefundStatus.Cancelled) {
      console.error('[paypal] refund not completed', { bookingId, refundId: result.id, status: result.status });
      saveFailedAttempt(store, booking, 'refund');
      throw new DepositError('declined', 402, `PayPal did not complete the refund (${result.status}).`);
    }

    const refundedNow = parseCents(result.amount?.value);
    const matches =
      refundedNow === params.amountCents && result.amount?.currencyCode === booking.deposit.currency;
    const refunds = [
      ...(booking.hold.refunds ?? []),
      {
        refundId: result.id!,
        // Record what PayPal says it refunded when that is readable.
        amountCents: refundedNow ?? params.amountCents!,
        status: result.status ?? 'UNKNOWN',
        refundedAt: now.toISOString(),
      },
    ];
    if (!matches) {
      console.error('[paypal] refunded amount differs from the request; needs review', {
        bookingId,
        refundId: result.id,
      });
      saveSettled(store, booking, { status: 'deposit_needs_review' }, { refunds });
      throw new DepositError(
        'amount_mismatch',
        502,
        'PayPal refunded a different amount than requested. Staff will review it.',
      );
    }

    const fullyRefunded = refundedCents({ ...booking.hold, refunds }) >= capture.amountCents;
    return saveSettled(
      store,
      booking,
      { status: fullyRefunded ? 'refunded' : 'partially_refunded' },
      { refunds },
    );
  });
}

export interface WalletPayPal {
  orders: Pick<OrdersController, 'createOrder'>;
  vault: Pick<VaultController, 'listCustomerPaymentTokens'>;
}

/**
 * Only after the hold is finished: its capture was final (final_capture), so it can't be captured
 * again. While a hold exists, staff capture the hold instead; charging the wallet as well would let
 * the customer pay the deposit twice.
 */
const WALLET_CHARGEABLE: BookingStatus[] = ['completed', 'no_show_charged'];
const FAILED_CHARGE = new Set<string>([CaptureStatus.Declined, CaptureStatus.Failed]);

/**
 * PayPal reports APPROVED instead of VAULTED when it hasn't finished storing the wallet. Before a
 * charge, ask PayPal for the customer's saved tokens and use the PayPal one if it is there now.
 */
async function ensureVaulted(
  paypal: WalletPayPal,
  store: BookingStore,
  booking: HeldBooking,
): Promise<HeldBooking> {
  const wallet = booking.hold.savedWallet;
  if (wallet?.status === 'VAULTED' && wallet.vaultId) return booking;
  if (!wallet?.customerId) {
    throw new DepositError(
      'invalid_state',
      409,
      `The saved PayPal wallet is not ready to charge (vault status ${wallet?.status ?? 'unknown'}).`,
    );
  }
  let tokens;
  try {
    tokens = (await paypal.vault.listCustomerPaymentTokens({ customerId: wallet.customerId })).result.paymentTokens;
  } catch (err) {
    const failure = describePayPalError(err);
    if (failure && failure.status < 500) {
      throw new DepositError('invalid_state', 409, 'PayPal has no saved wallet for this customer yet.', failure);
    }
    if (failure) throw new DepositError('paypal_error', 502, 'PayPal could not list the saved wallet. Please retry.', failure);
    if (isNetworkError(err)) {
      console.error('[paypal] vault lookup could not reach PayPal', { bookingId: booking.id, reason: describeTransportError(err) });
      throw new DepositError('network_error', 502, 'Could not reach PayPal. Please retry.');
    }
    throw sanitizeError(err, 'List saved wallet');
  }
  const token =
    tokens?.find((t) => t.id === wallet.vaultId && t.paymentSource?.paypal) ??
    tokens?.find((t) => t.paymentSource?.paypal);
  if (!token?.id) {
    throw new DepositError(
      'invalid_state',
      409,
      `The saved PayPal wallet is not ready to charge (vault status ${wallet.status ?? 'unknown'}).`,
    );
  }
  const updated: HeldBooking = {
    ...booking,
    hold: { ...booking.hold, savedWallet: { ...wallet, vaultId: token.id, status: 'VAULTED' } },
  };
  store.save(updated);
  return updated;
}

/**
 * Charges the customer's saved PayPal wallet while they are not present (merchant-initiated): a new
 * Orders v2 order with intent CAPTURE paid by the vault id, which PayPal completes without a popup.
 * Marked as a subsequent merchant-initiated use of the stored credential the customer agreed to at
 * checkout. One charge per booking, and together with any captured deposit it can't exceed the
 * deposit amount: a repeated click or a client retry after success is refused, not charged again.
 * The booking's status is left as it is.
 */
export function chargeSavedWallet(
  paypal: WalletPayPal,
  store: BookingStore,
  bookingId: string,
  request: { amountCents?: number },
  now: Date = new Date(),
): Promise<Booking> {
  return withBookingLock(bookingId, async () => {
    let booking = loadHeldBooking(store, bookingId);
    const replaying = booking.hold.pendingAction?.kind === 'wallet_charge';
    if (!booking.hold.savedWallet) {
      throw new DepositError(
        'invalid_state',
        409,
        'This customer did not save their PayPal wallet, so it cannot be charged without them.',
      );
    }

    const depositCents = booking.deposit.cents;
    let amountCents: number | undefined = request.amountCents;
    if (!replaying) {
      requireStatus(booking, WALLET_CHARGEABLE, 'charge the saved wallet for');
      if (booking.hold.walletCharges?.some((c) => !FAILED_CHARGE.has(c.status))) {
        throw new DepositError('invalid_state', 409, 'The saved wallet was already charged for this booking.');
      }
      const remaining = depositCents - (booking.hold.capture?.amountCents ?? 0);
      if (remaining < 1) {
        throw new DepositError('invalid_state', 409, 'The deposit was already captured in full; nothing is left to charge.');
      }
      amountCents = request.amountCents ?? remaining;
      if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > remaining) {
        throw new DepositError(
          'invalid_amount',
          400,
          `The charge must be a whole number of cents between 1 and ${remaining}.`,
        );
      }
      booking = await ensureVaulted(paypal, store, booking);
    }

    const vaultId = booking.hold.savedWallet!.vaultId!;
    const orders = paypal.orders;
    const sequence = (booking.hold.walletCharges?.length ?? 0) + 1;
    const { result: order, params } = await runMoneyAction(
      store,
      booking,
      {
        kind: 'wallet_charge',
        targetId: `${booking.id}-${sequence}`,
        params: { amountCents },
        label: 'charge the saved PayPal wallet',
        call: async (requestId, effective, attempt) =>
          (
            await orders.createOrder({
              paypalRequestId: requestId,
              prefer: 'return=representation',
              body: {
                intent: CheckoutPaymentIntent.Capture,
                purchaseUnits: [
                  {
                    referenceId: booking.id,
                    customId: booking.id,
                    invoiceId: `${booking.id}-wallet-${sequence}-${attempt}`,
                    description: 'SlotKeeper charge for your appointment',
                    amount: toMoney(booking.deposit.currency, effective.amountCents!),
                  },
                ],
                paymentSource: {
                  paypal: {
                    vaultId,
                    storedCredential: {
                      paymentInitiator: PaymentInitiator.Merchant,
                      usage: StoredPaymentSourceUsageType.Subsequent,
                      usagePattern: UsagePattern.UnscheduledPostpaid,
                    },
                  },
                },
              },
            })
          ).result,
        isReadable: (result) => Boolean(result?.id),
      },
      now,
    );

    const capture = order.purchaseUnits?.[0]?.payments?.captures?.[0];
    const took = capture?.status === CaptureStatus.Completed || capture?.status === CaptureStatus.Pending;
    if (order.status !== OrderStatus.Completed || !capture?.id || !took) {
      // E.g. PAYER_ACTION_REQUIRED: PayPal wants the customer present for this charge.
      console.error('[paypal] saved wallet charge not completed', {
        bookingId,
        orderId: order.id,
        orderStatus: order.status,
        captureStatus: capture?.status,
      });
      saveFailedAttempt(store, booking, 'wallet_charge');
      throw new DepositError(
        'declined',
        402,
        `PayPal did not complete the charge (order ${order.status ?? 'unknown'}, capture ${capture?.status ?? 'none'}).`,
      );
    }

    const charge = {
      orderId: order.id!,
      captureId: capture.id,
      amountCents: parseCents(capture.amount?.value) ?? params.amountCents!,
      status: capture.status!,
      chargedAt: now.toISOString(),
    };
    const charges = [...(booking.hold.walletCharges ?? []), charge];
    if (charge.amountCents !== params.amountCents || capture.amount?.currencyCode !== booking.deposit.currency) {
      console.error('[paypal] saved wallet charged a different amount; needs review', { bookingId, orderId: order.id });
      saveSettled(store, booking, { status: 'deposit_needs_review' }, { walletCharges: charges });
      throw new DepositError(
        'amount_mismatch',
        502,
        'PayPal charged a different amount than requested. Staff will review it.',
      );
    }
    return saveSettled(store, booking, {}, { walletCharges: charges });
  });
}
