import 'server-only';
import {
  AuthorizationStatus,
  CheckoutPaymentIntent,
  PaypalExperienceUserAction,
  PaypalPaymentTokenCustomerType,
  PaypalPaymentTokenUsageType,
  PaypalWalletContextShippingPreference,
  StoreInVaultInstruction,
  UsagePattern,
  type OrderRequest,
  type OrdersController,
} from '@paypal/paypal-server-sdk';
import { findService, formatAmount } from '@/lib/booking/catalog';
import { slotConflict } from '@/lib/booking/availability';
import { withBookingLock } from '@/lib/booking/locks';
import type { Booking, BookingStore, DepositHold } from '@/lib/booking/store';
import {
  describePayPalError,
  describeTransportError,
  isNetworkError,
  sanitizeError,
  type PayPalFailure,
} from './errors';

export type DepositErrorCode =
  | 'booking_not_found'
  | 'invalid_state'
  | 'order_mismatch'
  | 'not_approved'
  | 'declined'
  | 'amount_mismatch'
  | 'needs_review'
  | 'invalid_amount'
  | 'authorization_expired'
  | 'pending_action'
  | 'slot_taken'
  | 'paypal_error'
  | 'network_error';

export class DepositError extends Error {
  constructor(
    readonly code: DepositErrorCode,
    readonly httpStatus: number,
    message: string,
    readonly paypal?: PayPalFailure,
  ) {
    super(message);
    this.name = 'DepositError';
  }
}

/** The two Orders operations the deposit flow uses; tests pass a real controller over a stub adapter. */
export type DepositOrders = Pick<OrdersController, 'createOrder' | 'authorizeOrder'>;

export interface ReturnUrls {
  returnUrl: string;
  cancelUrl: string;
}

/** An order stays approvable for 3 hours; reuse it for a while, then start a fresh one. */
const ORDER_REUSE_MS = 2 * 60 * 60 * 1000;

/** PayPal issues that mean "this funding source said no"; the order can't be reused. */
const DECLINE_ISSUES = new Set(['INSTRUMENT_DECLINED', 'PAYER_ACTION_REQUIRED', 'TRANSACTION_REFUSED', 'PAYER_CANNOT_PAY']);

/*
 * PayPal-Request-Id values are deterministic rather than random UUIDs on purpose: the same logical
 * attempt must send the same id on every retry, so PayPal replays its stored result instead of
 * creating a second order or a second hold. Ids change only when an attempt definitely failed.
 */
const orderRequestId = (bookingId: string, attempt: number) =>
  `slotkeeper-deposit-order-${bookingId}-${attempt}`;
const authorizeRequestId = (orderId: string, attempt: number) =>
  `slotkeeper-deposit-authorize-${orderId}-${attempt}`;

export interface CheckoutOptions {
  /** The customer agreed to save their PayPal wallet for later merchant-initiated charges. */
  savePayment?: boolean;
}

/** Shown to the customer by PayPal when they agree to save their wallet. */
const VAULT_DESCRIPTION = 'SlotKeeper may charge future booking deposits and no-show fees.';

/**
 * Orders v2 request for a deposit hold: intent AUTHORIZE, amount from the server-side catalog,
 * no shipping (it's a service), booking id on the purchase unit for reconciliation. With
 * `savePayment`, PayPal also stores the wallet once the authorization succeeds (ON_SUCCESS), as a
 * merchant token for unscheduled charges made after the appointment (no-show fees, later deposits).
 */
export function buildDepositOrderRequest(
  booking: Booking,
  urls: ReturnUrls,
  options: CheckoutOptions = {},
): OrderRequest {
  const service = findService(booking.serviceId);
  if (!service) throw new DepositError('invalid_state', 409, `Unknown service ${booking.serviceId}.`);
  const vault = options.savePayment
    ? {
        attributes: {
          vault: {
            storeInVault: StoreInVaultInstruction.OnSuccess,
            usageType: PaypalPaymentTokenUsageType.Merchant,
            customerType: PaypalPaymentTokenCustomerType.Consumer,
            usagePattern: UsagePattern.UnscheduledPostpaid,
            description: VAULT_DESCRIPTION,
            permitMultiplePaymentTokens: false,
          },
        },
      }
    : {};
  return {
    intent: CheckoutPaymentIntent.Authorize,
    purchaseUnits: [
      {
        referenceId: booking.id,
        customId: booking.id,
        description: `Deposit: ${service.name} on ${booking.startsAt}`.slice(0, 127),
        amount: {
          currencyCode: booking.deposit.currency,
          value: formatAmount(booking.deposit),
        },
      },
    ],
    paymentSource: {
      paypal: {
        experienceContext: {
          brandName: 'SlotKeeper',
          shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
          userAction: PaypalExperienceUserAction.PayNow,
          returnUrl: urls.returnUrl,
          cancelUrl: urls.cancelUrl,
        },
        ...vault,
      },
    },
  };
}

/** Why a booking can't take a new deposit. Staff-review cases must not tell the customer to pay again. */
function notAwaitingDeposit(booking: Booking): DepositError {
  if (booking.status === 'deposit_needs_review') {
    return new DepositError('invalid_state', 409, 'This booking is under staff review.');
  }
  return new DepositError('invalid_state', 409, 'This booking already has a deposit.');
}

function loadBooking(store: BookingStore, bookingId: string): Booking {
  const booking = store.get(bookingId);
  if (!booking) throw new DepositError('booking_not_found', 404, 'Booking not found.');
  return booking;
}

function saveHold(store: BookingStore, booking: Booking, changes: Partial<DepositHold>): Booking {
  if (!booking.hold) throw new Error('saveHold called on a booking without a hold');
  const updated: Booking = { ...booking, hold: { ...booking.hold, ...changes } };
  store.save(updated);
  return updated;
}

/** Turns a PayPal API failure into a DepositError, logging the debug id. */
function fromPayPalFailure(failure: PayPalFailure, action: string): DepositError {
  console.error(`[paypal] ${action} failed`, {
    status: failure.status,
    issue: failure.issue,
    debugId: failure.debugId,
  });
  if (failure.issue === 'ORDER_NOT_APPROVED') {
    return new DepositError('not_approved', 409, 'The customer has not approved the payment yet.', failure);
  }
  if (failure.issue && DECLINE_ISSUES.has(failure.issue)) {
    return new DepositError(
      'declined',
      402,
      'PayPal declined this payment method. Please start checkout again and choose another one.',
      failure,
    );
  }
  return new DepositError(
    'paypal_error',
    failure.status >= 500 ? 502 : 422,
    `PayPal could not ${action} (HTTP ${failure.status}${failure.issue ? `, ${failure.issue}` : ''}).`,
    failure,
  );
}

function networkError(err: Error, action: string): DepositError {
  // Never log `err` itself: an axios error carries the request's Authorization header.
  console.error(`[paypal] ${action} could not reach PayPal`, { reason: describeTransportError(err) });
  return new DepositError('network_error', 502, 'Could not reach PayPal. Please try again.');
}

/**
 * Creates (or reuses) the PayPal order for a booking's deposit and returns its id for the JS SDK.
 * Before handing out an order it settles any authorize call whose outcome is unknown, so a lost
 * response can never turn into a second hold on the customer.
 */
export function createDepositOrder(
  orders: DepositOrders,
  store: BookingStore,
  bookingId: string,
  urls: ReturnUrls,
  now: Date = new Date(),
  options: CheckoutOptions = {},
): Promise<{ orderId: string; approveUrl?: string }> {
  return withBookingLock(
    bookingId,
    () => createDepositOrderLocked(orders, store, bookingId, urls, now, options),
    'wait',
  );
}

async function createDepositOrderLocked(
  orders: DepositOrders,
  store: BookingStore,
  bookingId: string,
  urls: ReturnUrls,
  now: Date,
  options: CheckoutOptions,
): Promise<{ orderId: string; approveUrl?: string }> {
  const savePayment = options.savePayment === true;
  let booking = loadBooking(store, bookingId);
  if (booking.status !== 'awaiting_deposit') {
    throw notAwaitingDeposit(booking);
  }

  if (booking.hold?.authorizeOutcomeUnknown) {
    try {
      booking = await runAuthorize(orders, store, booking, now);
    } catch (err) {
      // not_approved: the earlier authorize never happened, so the order is still usable.
      // declined: runAuthorize marked the order spent; a new one is created below.
      if (!(err instanceof DepositError) || (err.code !== 'not_approved' && err.code !== 'declined')) {
        throw err;
      }
      booking = loadBooking(store, bookingId);
    }
    if (booking.status !== 'awaiting_deposit') {
      throw notAwaitingDeposit(booking);
    }
  }

  const existing = booking.hold;
  // An order is only reused if it asks for the same thing: ticking or unticking "save my PayPal"
  // changes the order body, so it needs a new order.
  if (
    existing &&
    !existing.orderSpent &&
    (existing.savePayment ?? false) === savePayment &&
    now.getTime() - Date.parse(existing.orderCreatedAt) < ORDER_REUSE_MS
  ) {
    return { orderId: existing.paypalOrderId, approveUrl: existing.approveUrl };
  }

  const attempt = (existing?.orderAttempt ?? 0) + 1;
  // Built outside the try: a local problem (e.g. unknown service) must not be mistaken for a PayPal failure.
  const body = buildDepositOrderRequest(booking, urls, { savePayment });
  let orderId: string | undefined;
  let approveUrl: string | undefined;
  try {
    const response = await orders.createOrder({
      body,
      paypalRequestId: orderRequestId(booking.id, attempt),
      prefer: 'return=minimal',
    });
    orderId = response.result?.id;
    // Where the customer approves when not using our page's PayPal button (e.g. booked by an AI assistant).
    approveUrl = response.result?.links?.find((link) => link.rel === 'payer-action' || link.rel === 'approve')?.href;
  } catch (err) {
    const failure = describePayPalError(err);
    if (failure) throw fromPayPalFailure(failure, 'create the deposit order');
    if (isNetworkError(err)) throw networkError(err, 'create the deposit order');
    throw sanitizeError(err, 'Create deposit order');
  }
  if (!orderId) {
    throw new DepositError('paypal_error', 502, 'PayPal did not return an order id.');
  }

  store.save({
    ...booking,
    hold: {
      paypalOrderId: orderId,
      orderAttempt: attempt,
      orderCreatedAt: now.toISOString(),
      ...(savePayment ? { savePayment: true } : {}),
      ...(approveUrl ? { approveUrl } : {}),
    },
  });
  return { orderId, approveUrl };
}

/**
 * After the customer approves in the PayPal popup: authorizes the order (holds the deposit, no money
 * moves yet) and records the authorization id on the booking for the later capture/void.
 */
/**
 * Called by the browser after approval, and by the CHECKOUT.ORDER.APPROVED webhook when the customer
 * closed the tab first. Both queue on the booking lock; the second sees the hold and stops.
 */
export function authorizeDeposit(
  orders: DepositOrders,
  store: BookingStore,
  bookingId: string,
  orderId: string,
  now: Date = new Date(),
): Promise<Booking> {
  return authorizeDepositReporting(orders, store, bookingId, orderId, now).then((r) => r.booking);
}

/** As `authorizeDeposit`, also saying whether this call placed the hold or found it already there. */
export function authorizeDepositReporting(
  orders: DepositOrders,
  store: BookingStore,
  bookingId: string,
  orderId: string,
  now: Date = new Date(),
): Promise<{ booking: Booking; alreadyHeld: boolean }> {
  return withBookingLock(bookingId, () => authorizeDepositLocked(orders, store, bookingId, orderId, now), 'wait');
}

async function authorizeDepositLocked(
  orders: DepositOrders,
  store: BookingStore,
  bookingId: string,
  orderId: string,
  now: Date,
): Promise<{ booking: Booking; alreadyHeld: boolean }> {
  const booking = loadBooking(store, bookingId);

  if (booking.hold?.paypalOrderId !== orderId) {
    throw new DepositError('order_mismatch', 409, 'This PayPal order does not belong to the booking.');
  }
  // Already authorized (double click, retried request): return what we stored.
  if (booking.status !== 'awaiting_deposit' && booking.hold.authorizationId) {
    return { booking, alreadyHeld: true };
  }
  // Only a booking still waiting for its deposit may get one (or a retry of an unknown outcome).
  // A cancelled booking keeps its PayPal order, so its old checkout tab must not hold money.
  if (booking.status !== 'awaiting_deposit' && !booking.hold.authorizeOutcomeUnknown) {
    throw new DepositError('invalid_state', 409, `This booking is "${booking.status}"; no deposit can be placed.`);
  }
  if (booking.hold.orderSpent) {
    throw new DepositError(
      'invalid_state',
      409,
      'This PayPal order can no longer be used. Please start checkout again.',
    );
  }
  // One paid deposit per staff member and time: re-check the slot and authorize under the slots lock
  // (lock order: booking, then slots), so a customer who approves an old link after their unpaid hold
  // lapsed and the slot went to someone else is refused. Approval alone holds no money.
  return withBookingLock(
    'slots',
    async () => {
      if (booking.status === 'awaiting_deposit' && !booking.hold!.authorizeOutcomeUnknown) {
        const conflict = slotConflict(store.list(), booking, now);
        if (conflict) {
          console.error('[paypal] slot taken before the deposit was authorized', {
            bookingId: booking.id,
            takenBy: conflict.id,
          });
          throw new DepositError(
            'slot_taken',
            409,
            'This time was given to another customer while the deposit waited. Nothing was charged; please book another time.',
          );
        }
      }
      return { booking: await runAuthorize(orders, store, booking, now), alreadyHeld: false };
    },
    'wait',
  );
}

async function runAuthorize(
  orders: DepositOrders,
  store: BookingStore,
  booking: Booking,
  now: Date,
): Promise<Booking> {
  const hold = booking.hold!;
  const attempt = hold.authorizeAttempt ?? 1;

  let result;
  try {
    const response = await orders.authorizeOrder({
      id: hold.paypalOrderId,
      paypalRequestId: authorizeRequestId(hold.paypalOrderId, attempt),
      prefer: 'return=representation',
    });
    result = response.result;
  } catch (err) {
    const failure = describePayPalError(err);
    if (failure?.issue === 'ORDER_ALREADY_AUTHORIZED') {
      // PayPal already holds an authorization for this order (e.g. a replay outside PayPal's
      // request-id retention). Which one is unknown to us, so staff must check before anything else.
      console.error('[paypal] order already authorized; needs review', {
        bookingId: booking.id,
        orderId: hold.paypalOrderId,
        debugId: failure.debugId,
      });
      store.save({
        ...booking,
        status: 'deposit_needs_review',
        hold: { ...hold, authorizeOutcomeUnknown: false, orderSpent: true },
      });
      throw new DepositError(
        'needs_review',
        409,
        'PayPal says this order already has an authorization. Staff will check it before anything else happens.',
        failure,
      );
    }
    if (failure && failure.status < 500) {
      // A definite 4xx answer: nothing was held. The next attempt needs a fresh request id, or PayPal
      // could replay this failure; a decline also means this order can't be approved again.
      const depositError = fromPayPalFailure(failure, 'authorize the deposit');
      saveHold(store, booking, {
        authorizeAttempt: attempt + 1,
        authorizeOutcomeUnknown: false,
        orderSpent: hold.orderSpent || depositError.code === 'declined',
      });
      throw depositError;
    }
    // Anything else (a 5xx, no response, or a 2xx we couldn't read): PayPal may already have held
    // the funds. Keep the same request id and replay it before anything else (createDepositOrder
    // does this on the next checkout).
    saveHold(store, booking, { authorizeOutcomeUnknown: true });
    if (failure) throw fromPayPalFailure(failure, 'authorize the deposit');
    if (isNetworkError(err)) throw networkError(err, 'authorize the deposit');
    console.error('[paypal] authorize response could not be read; outcome unknown', {
      bookingId: booking.id,
      orderId: hold.paypalOrderId,
    });
    throw new DepositError(
      'paypal_error',
      502,
      'PayPal returned a response this app could not read. The deposit will be checked before the next attempt.',
    );
  }

  const authorization = result?.purchaseUnits?.[0]?.payments?.authorizations?.[0];
  if (!authorization?.id) {
    saveHold(store, booking, { authorizeOutcomeUnknown: true });
    throw new DepositError('paypal_error', 502, 'PayPal did not return an authorization.');
  }

  // With savePayment, PayPal stores the wallet once the authorization succeeds and reports the
  // payment token here (status VAULTED), or APPROVED if storing is still pending.
  const vault = result?.paymentSource?.paypal?.attributes?.vault;
  if (hold.savePayment && !vault?.id) {
    console.error('[paypal] wallet was not saved although the customer opted in', {
      bookingId: booking.id,
      orderId: hold.paypalOrderId,
      vaultStatus: vault?.status,
    });
  }
  const recorded: Partial<DepositHold> = {
    authorizeOutcomeUnknown: false,
    authorizationId: authorization.id,
    authorizationStatus: authorization.status,
    expiresAt: authorization.expirationTime,
    heldAt: now.toISOString(),
    ...(vault?.id || vault?.status
      ? {
          savedWallet: {
            vaultId: vault.id,
            status: vault.status,
            customerId: vault.customer?.id,
            savedAt: now.toISOString(),
          },
        }
      : {}),
  };

  const expected = formatAmount(booking.deposit);
  const amount = authorization.amount;
  if (!amount || amount.value !== expected || amount.currencyCode !== booking.deposit.currency) {
    // Funds are held at PayPal, so keep the authorization id: the void step (or staff) must release it.
    console.error('[paypal] authorization does not match the booking deposit; needs review', {
      bookingId: booking.id,
      orderId: hold.paypalOrderId,
      authorizationId: authorization.id,
    });
    store.save({ ...booking, status: 'deposit_needs_review', hold: { ...hold, ...recorded } });
    throw new DepositError(
      'amount_mismatch',
      502,
      'PayPal authorized a different amount than the deposit. Staff will review it.',
    );
  }

  if (
    authorization.status !== AuthorizationStatus.Created &&
    authorization.status !== AuthorizationStatus.Pending
  ) {
    // The order now carries a failed authorization and can't be approved again.
    console.error('[paypal] deposit authorization was not held', {
      bookingId: booking.id,
      authorizationId: authorization.id,
      status: authorization.status,
    });
    saveHold(store, booking, {
      authorizeAttempt: attempt + 1,
      authorizeOutcomeUnknown: false,
      orderSpent: true,
    });
    throw new DepositError(
      'declined',
      402,
      `PayPal did not hold the deposit (authorization ${authorization.status ?? 'without status'}). Please start checkout again.`,
    );
  }

  const updated: Booking = {
    ...booking,
    status: authorization.status === AuthorizationStatus.Created ? 'deposit_held' : 'deposit_pending',
    hold: { ...hold, ...recorded },
  };
  store.save(updated);
  return updated;
}
