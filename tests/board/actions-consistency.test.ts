import { describe, expect, it, vi } from 'vitest';
import { actionRequest, bookingActions, type BoardAction, type BoardBooking } from '@/lib/board/view';
import { createMemoryBookingStore, type Booking, type DepositHold } from '@/lib/booking/store';
import {
  captureDeposit,
  chargeSavedWallet,
  refundDeposit,
  reauthorizeDeposit,
  voidDeposit,
  type DepositPayments,
  type WalletPayPal,
} from '@/lib/paypal/deposit-actions';

/**
 * The board offers a button only when the server would act on it. For each booking state, every
 * request the board could send is run through the real server functions with a PayPal stub that
 * only records whether it was reached; the requests that reach PayPal must be exactly the ones the
 * board offers. Reauthorize is left out on purpose: it is an API route and copilot step, not a button
 * (the board only offers it as the retry of an unconfirmed renewal).
 */

// Fixed clock: tests never depend on the real date.
const NOW = new Date('2026-11-04T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const CAPTURE = { captureId: 'CAP-1', status: 'COMPLETED', capturedAt: ago(HOUR) };
const WALLET = { vaultId: 'VAULT-1', status: 'VAULTED', customerId: 'CUST-1', savedAt: ago(2 * HOUR) };

function booking(status: Booking['status'], hold: Partial<DepositHold> = {}): Booking {
  return {
    id: 'B-1',
    serviceId: 'haircut',
    customerName: 'Ana',
    startsAt: ago(-24 * HOUR),
    deposit: { currency: 'USD', cents: 1000 },
    status,
    createdAt: ago(3 * HOUR),
    hold: {
      paypalOrderId: 'ORDER-1',
      orderAttempt: 1,
      orderCreatedAt: ago(3 * HOUR),
      authorizationId: 'AUTH-1',
      authorizationStatus: 'CREATED',
      ...hold,
    },
  };
}

/** Sends one request the way the route handlers do, and reports whether PayPal was called. */
async function reachesPayPal(stored: Booking, path: string, body: Record<string, unknown> | undefined): Promise<boolean> {
  const store = createMemoryBookingStore();
  store.save(stored);
  let reached = false;
  const touch = async (): Promise<never> => {
    reached = true;
    throw new Error('stub: PayPal reached');
  };
  const payments = {
    captureAuthorizedPayment: touch,
    voidPayment: touch,
    reauthorizePayment: touch,
    refundCapturedPayment: touch,
  } as unknown as DepositPayments;
  const wallet = { orders: { createOrder: touch }, vault: { listCustomerPaymentTokens: touch } } as unknown as WalletPayPal;
  // Like the routes, the request goes through JSON: undefined fields disappear.
  const sent = body === undefined ? {} : (JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
  const amountCents = sent.amountCents as number | undefined;
  const id = stored.id;
  const run: Record<string, () => Promise<unknown>> = {
    [`/api/bookings/${id}/deposit/capture`]: () =>
      captureDeposit(payments, store, id, { reason: sent.reason as 'completed' | 'no_show', amountCents }, NOW),
    [`/api/bookings/${id}/deposit/void`]: () => voidDeposit(payments, store, id, NOW),
    [`/api/bookings/${id}/deposit/reauthorize`]: () => reauthorizeDeposit(payments, store, id, NOW),
    [`/api/bookings/${id}/deposit/refund`]: () => refundDeposit(payments, store, id, { amountCents }, NOW),
    [`/api/bookings/${id}/wallet/charge`]: () => chargeSavedWallet(wallet, store, id, { amountCents }, NOW),
  };
  const call = run[path];
  if (!call) throw new Error(`no server function for ${path}`);
  await call().catch(() => undefined);
  return reached;
}

const signature = (action: BoardAction, id: string) => {
  const { path, body } = actionRequest(action, id);
  return `${path} ${JSON.stringify(body ?? null)}`;
};

/** Every request the board can send for this booking, offered or not. */
function candidates(stored: Booking): BoardAction[] {
  const cents = stored.deposit.cents;
  const all: BoardAction[] = [
    { kind: 'capture', cents },
    { kind: 'no_show', maxCents: cents },
    { kind: 'void' },
    { kind: 'refund', maxCents: cents },
    { kind: 'wallet', maxCents: cents },
  ];
  const pending = stored.hold?.pendingAction;
  if (pending) all.push({ kind: 'retry', pending: pending.kind, reason: pending.reason });
  return all;
}

const pending = (kind: 'capture' | 'void' | 'reauthorize' | 'refund' | 'wallet_charge', since: string, extra: object = {}) => ({
  pendingAction: { kind, requestId: `slotkeeper-${kind}-x-1`, since, ...extra },
});

const CASES: Array<[string, Booking]> = [
  ['deposit held', booking('deposit_held')],
  ['deposit pending at PayPal', booking('deposit_pending', { authorizationStatus: 'PENDING' })],
  ['needs review, nothing captured', booking('deposit_needs_review')],
  ['needs review, captured', booking('deposit_needs_review', { capture: { ...CAPTURE, amountCents: 1000, reason: 'completed' } })],
  ['completed', booking('completed', { capture: { ...CAPTURE, amountCents: 1000, reason: 'completed' } })],
  ['completed, saved wallet, full capture', booking('completed', { capture: { ...CAPTURE, amountCents: 1000, reason: 'completed' }, savedWallet: WALLET })],
  ['no-show fee, saved wallet', booking('no_show_charged', { capture: { ...CAPTURE, amountCents: 400, reason: 'no_show' }, savedWallet: WALLET })],
  [
    'no-show fee, wallet already charged',
    booking('no_show_charged', {
      capture: { ...CAPTURE, amountCents: 400, reason: 'no_show' },
      savedWallet: WALLET,
      walletCharges: [{ orderId: 'O-W', captureId: 'CAP-W', amountCents: 600, status: 'COMPLETED', chargedAt: ago(HOUR) }],
    }),
  ],
  [
    'no-show fee, wallet charge declined',
    booking('no_show_charged', {
      capture: { ...CAPTURE, amountCents: 400, reason: 'no_show' },
      savedWallet: WALLET,
      walletCharges: [{ orderId: 'O-W', captureId: 'CAP-W', amountCents: 600, status: 'DECLINED', chargedAt: ago(HOUR) }],
    }),
  ],
  [
    'partially refunded',
    booking('partially_refunded', {
      capture: { ...CAPTURE, amountCents: 1000, reason: 'completed' },
      refunds: [{ refundId: 'R-1', amountCents: 300, status: 'COMPLETED', refundedAt: ago(HOUR) }],
    }),
  ],
  [
    'refunded',
    booking('refunded', {
      capture: { ...CAPTURE, amountCents: 1000, reason: 'completed' },
      refunds: [{ refundId: 'R-1', amountCents: 1000, status: 'COMPLETED', refundedAt: ago(HOUR) }],
    }),
  ],
  ['cancelled', booking('cancelled', { authorizationStatus: 'VOIDED', voidedAt: ago(HOUR) })],
  ['awaiting deposit (no authorization)', { ...booking('awaiting_deposit'), hold: { paypalOrderId: 'ORDER-1', orderAttempt: 1, orderCreatedAt: ago(HOUR) } }],
  ['no-show capture unconfirmed, inside the window', booking('deposit_held', pending('capture', ago(HOUR), { amountCents: 400, reason: 'no_show' }))],
  ['full capture unconfirmed, inside the window', booking('deposit_held', pending('capture', ago(HOUR), { amountCents: 1000, reason: 'completed' }))],
  [
    'refund unconfirmed, past the window',
    booking('completed', {
      capture: { ...CAPTURE, amountCents: 1000, reason: 'completed' },
      ...pending('refund', ago(45 * 24 * HOUR), { amountCents: 1000 }),
    }),
  ],
  [
    'wallet charge unconfirmed, past the window',
    booking('no_show_charged', {
      capture: { ...CAPTURE, amountCents: 400, reason: 'no_show' },
      savedWallet: WALLET,
      ...pending('wallet_charge', ago(6 * HOUR), { amountCents: 600 }),
    }),
  ],
  [
    'wallet charge unconfirmed, inside the window',
    booking('no_show_charged', {
      capture: { ...CAPTURE, amountCents: 400, reason: 'no_show' },
      savedWallet: WALLET,
      ...pending('wallet_charge', ago(HOUR), { amountCents: 600 }),
    }),
  ],
  ['needs review, void unconfirmed, inside the window', booking('deposit_needs_review', pending('void', ago(HOUR)))],
  ['renewal unconfirmed, inside the window', booking('deposit_held', pending('reauthorize', ago(HOUR), { amountCents: 1000 }))],
];

describe('board buttons match what the server accepts', () => {
  it.each(CASES)('%s', async (_name, stored) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const offered = new Set(bookingActions(stored as unknown as BoardBooking, NOW).map((a) => signature(a, stored.id)));
    const accepted = new Set<string>();
    for (const action of candidates(stored)) {
      const { path, body } = actionRequest(action, stored.id);
      if (await reachesPayPal(stored, path, body)) accepted.add(signature(action, stored.id));
    }
    expect([...offered].sort()).toEqual([...accepted].sort());
    vi.restoreAllMocks();
  });

  it('covers a case where every kind of button is offered', () => {
    const kinds = new Set(CASES.flatMap(([, b]) => bookingActions(b as unknown as BoardBooking, NOW).map((a) => a.kind)));
    expect([...kinds].sort()).toEqual(['capture', 'no_show', 'refund', 'retry', 'void', 'wallet']);
  });
});
