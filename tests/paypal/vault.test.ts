import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publicBooking } from '@/lib/api/responses';
import { createBooking } from '@/lib/booking/bookings';
import {
  createMemoryBookingStore,
  type Booking,
  type BookingStore,
  type DepositHold,
} from '@/lib/booking/store';
import { captureDeposit, chargeSavedWallet, refundDeposit } from '@/lib/paypal/deposit-actions';
import { authorizeDeposit, createDepositOrder } from '@/lib/paypal/deposits';
import { networkDrop, stubPayPal, type Reply } from '../helpers/paypal-stub';

// Fixed clock: tests never depend on the real date.
const NOW = new Date('2026-11-01T00:00:00.000Z');
const API = 'https://api-m.sandbox.paypal.com';
const URLS = { returnUrl: 'https://app.test/return', cancelUrl: 'https://app.test/cancel' };

function newBooking(store: BookingStore): Booking {
  return createBooking(
    store,
    { serviceId: 'haircut', customerName: 'Ana', startsAt: '2026-11-02T10:00:00.000Z' },
    NOW,
  );
}

/**
 * A no-show: 4.00 of the 10.00 deposit hold was captured (final), and the customer saved their
 * wallet (vault token VAULT-1), so up to 6.00 more can be charged to it.
 */
function bookingWithWallet(store: BookingStore, wallet: Partial<DepositHold['savedWallet']> = {}): Booking {
  const booking: Booking = {
    ...newBooking(store),
    status: 'no_show_charged',
    hold: {
      paypalOrderId: 'ORDER-1',
      orderAttempt: 1,
      orderCreatedAt: NOW.toISOString(),
      savePayment: true,
      authorizationId: 'AUTH-1',
      authorizationStatus: 'CAPTURED',
      capture: { captureId: 'CAP-1', amountCents: 400, status: 'COMPLETED', reason: 'no_show', capturedAt: NOW.toISOString() },
      savedWallet: { vaultId: 'VAULT-1', status: 'VAULTED', customerId: 'CUST-1', savedAt: NOW.toISOString(), ...wallet },
    },
  };
  store.save(booking);
  return booking;
}

const orderCreated = (id = 'ORDER-1'): Reply => ({ status: 201, body: { id, status: 'PAYER_ACTION_REQUIRED' } });

const authorizeReply = (bookingId: string, vault?: Record<string, unknown>): Reply => ({
  status: 201,
  body: {
    id: 'ORDER-1',
    status: 'COMPLETED',
    payment_source: vault ? { paypal: { email_address: 'buyer@example.com', attributes: { vault } } } : undefined,
    purchase_units: [
      {
        reference_id: bookingId,
        payments: {
          authorizations: [
            { id: 'AUTH-1', status: 'CREATED', amount: { currency_code: 'USD', value: '10.00' }, expiration_time: '2026-11-30T00:00:00Z' },
          ],
        },
      },
    ],
  },
});

const walletCharged = (value = '4.00', orderStatus = 'COMPLETED', captureStatus = 'COMPLETED'): Reply => ({
  status: 201,
  body: {
    id: 'ORDER-W1',
    status: orderStatus,
    purchase_units: [
      {
        payments:
          captureStatus === 'NONE'
            ? undefined
            : { captures: [{ id: 'CAP-W1', status: captureStatus, amount: { currency_code: 'USD', value } }] },
      },
    ],
  },
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('saving the wallet at checkout', () => {
  it('asks PayPal to vault the wallet on success when the customer opts in', async () => {
    const store = createMemoryBookingStore();
    const booking = newBooking(store);
    const paypal = stubPayPal(orderCreated());

    await createDepositOrder(paypal.orders, store, booking.id, URLS, NOW, { savePayment: true });

    expect(paypal.requests[0].body.payment_source.paypal.attributes).toEqual({
      vault: {
        store_in_vault: 'ON_SUCCESS',
        usage_type: 'MERCHANT',
        customer_type: 'CONSUMER',
        usage_pattern: 'UNSCHEDULED_POSTPAID',
        description: 'SlotKeeper may charge future booking deposits and no-show fees.',
        permit_multiple_payment_tokens: false,
      },
    });
    expect(store.get(booking.id)!.hold!.savePayment).toBe(true);
  });

  it('sends no vault fields without consent', async () => {
    const store = createMemoryBookingStore();
    const booking = newBooking(store);
    const paypal = stubPayPal(orderCreated());
    await createDepositOrder(paypal.orders, store, booking.id, URLS, NOW);
    expect(paypal.requests[0].body.payment_source.paypal.attributes).toBeUndefined();
    expect(store.get(booking.id)!.hold!.savePayment).toBeUndefined();
  });

  it('creates a new order when the save choice changes, and reuses it while it stays the same', async () => {
    const store = createMemoryBookingStore();
    const booking = newBooking(store);
    const paypal = stubPayPal(orderCreated('ORDER-1'), orderCreated('ORDER-2'));

    expect(await createDepositOrder(paypal.orders, store, booking.id, URLS, NOW)).toEqual({ orderId: 'ORDER-1' });
    expect(
      await createDepositOrder(paypal.orders, store, booking.id, URLS, NOW, { savePayment: true }),
    ).toEqual({ orderId: 'ORDER-2' });
    expect(
      await createDepositOrder(paypal.orders, store, booking.id, URLS, NOW, { savePayment: true }),
    ).toEqual({ orderId: 'ORDER-2' });

    expect(paypal.requests.map((r) => r.headers['paypal-request-id'])).toEqual([
      `slotkeeper-deposit-order-${booking.id}-1`,
      `slotkeeper-deposit-order-${booking.id}-2`,
    ]);
  });

  it('records the vault token PayPal returns with the authorization', async () => {
    const store = createMemoryBookingStore();
    const booking = newBooking(store);
    const paypal = stubPayPal(
      orderCreated(),
      authorizeReply(booking.id, { id: 'VAULT-1', status: 'VAULTED', customer: { id: 'CUST-1' } }),
    );
    await createDepositOrder(paypal.orders, store, booking.id, URLS, NOW, { savePayment: true });

    const held = await authorizeDeposit(paypal.orders, store, booking.id, 'ORDER-1', NOW);

    expect(held.status).toBe('deposit_held');
    expect(held.hold!.savedWallet).toEqual({
      vaultId: 'VAULT-1',
      status: 'VAULTED',
      customerId: 'CUST-1',
      savedAt: NOW.toISOString(),
    });
  });

  it('still holds the deposit, and logs it, when PayPal did not save an opted-in wallet', async () => {
    const store = createMemoryBookingStore();
    const booking = newBooking(store);
    const paypal = stubPayPal(orderCreated(), authorizeReply(booking.id));
    await createDepositOrder(paypal.orders, store, booking.id, URLS, NOW, { savePayment: true });

    const held = await authorizeDeposit(paypal.orders, store, booking.id, 'ORDER-1', NOW);

    expect(held.status).toBe('deposit_held');
    expect(held.hold!.savedWallet).toBeUndefined();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain('wallet was not saved');
  });
});

describe('chargeSavedWallet', () => {
  it('creates a CAPTURE order paid by the vault id, marked as a merchant-initiated subsequent charge', async () => {
    const store = createMemoryBookingStore();
    const booking = bookingWithWallet(store);
    const paypal = stubPayPal(walletCharged('4.00'));

    const result = await chargeSavedWallet(paypal, store, booking.id, { amountCents: 400 }, NOW);

    const req = paypal.requests[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${API}/v2/checkout/orders`);
    expect(req.headers['paypal-request-id']).toBe(`slotkeeper-wallet_charge-${booking.id}-1-1`);
    expect(req.headers.prefer).toBe('return=representation');
    expect(req.body).toEqual({
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: booking.id,
          custom_id: booking.id,
          invoice_id: `${booking.id}-wallet-1-1`,
          description: 'SlotKeeper charge for your appointment',
          amount: { currency_code: 'USD', value: '4.00' },
        },
      ],
      payment_source: {
        paypal: {
          vault_id: 'VAULT-1',
          stored_credential: {
            payment_initiator: 'MERCHANT',
            usage: 'SUBSEQUENT',
            usage_pattern: 'UNSCHEDULED_POSTPAID',
          },
        },
      },
    });
    expect(result.status).toBe('no_show_charged');
    expect(result.hold!.walletCharges).toEqual([
      { orderId: 'ORDER-W1', captureId: 'CAP-W1', amountCents: 400, status: 'COMPLETED', chargedAt: NOW.toISOString() },
    ]);
  });

  it('refuses without a saved wallet, or an unfinished one PayPal cannot be asked about, without calling PayPal', async () => {
    const store = createMemoryBookingStore();
    const paypal = stubPayPal();
    const noWallet = bookingWithWallet(store);
    store.save({ ...noWallet, hold: { ...noWallet.hold!, savedWallet: undefined } });
    const notReady = bookingWithWallet(store, { vaultId: undefined, status: 'APPROVED', customerId: undefined });
    await expect(chargeSavedWallet(paypal, store, noWallet.id, {}, NOW)).rejects.toMatchObject({
      code: 'invalid_state',
    });
    await expect(chargeSavedWallet(paypal, store, notReady.id, {}, NOW)).rejects.toMatchObject({
      code: 'invalid_state',
      message: expect.stringContaining('APPROVED'),
    });
    expect(paypal.requests).toHaveLength(0);
  });

  it('R2: an APPROVED wallet is looked up with PayPal, marked VAULTED, and then charged', async () => {
    const store = createMemoryBookingStore();
    const booking = bookingWithWallet(store, { vaultId: undefined, status: 'APPROVED' });
    const paypal = stubPayPal(
      {
        status: 200,
        body: {
          customer: { id: 'CUST-1' },
          payment_tokens: [{ id: 'VAULT-9', payment_source: { paypal: { email_address: 'buyer@example.com' } } }],
        },
      },
      walletCharged('4.00'),
    );

    const result = await chargeSavedWallet(paypal, store, booking.id, { amountCents: 400 }, NOW);

    expect(paypal.requests[0]).toMatchObject({ method: 'GET' });
    expect(paypal.requests[0].url).toContain('/v3/vault/payment-tokens');
    expect(paypal.requests[0].url).toContain('customer_id=CUST-1');
    expect(paypal.requests[1].body.payment_source.paypal.vault_id).toBe('VAULT-9');
    expect(result.hold!.savedWallet).toMatchObject({ vaultId: 'VAULT-9', status: 'VAULTED' });
  });

  it('R2: an APPROVED wallet PayPal still has no token for is refused', async () => {
    const store = createMemoryBookingStore();
    const booking = bookingWithWallet(store, { vaultId: undefined, status: 'APPROVED' });
    const paypal = stubPayPal({ status: 200, body: { customer: { id: 'CUST-1' }, payment_tokens: [] } });
    await expect(chargeSavedWallet(paypal, store, booking.id, {}, NOW)).rejects.toMatchObject({
      code: 'invalid_state',
    });
    expect(paypal.requests).toHaveLength(1);
  });

  it('R1: a second charge after a successful one is refused without calling PayPal', async () => {
    const store = createMemoryBookingStore();
    const booking = bookingWithWallet(store);
    const paypal = stubPayPal(walletCharged('4.00'));
    await chargeSavedWallet(paypal, store, booking.id, { amountCents: 400 }, NOW);
    await expect(
      chargeSavedWallet(paypal, store, booking.id, { amountCents: 400 }, NOW),
    ).rejects.toMatchObject({ code: 'invalid_state', message: expect.stringContaining('already charged') });
    expect(paypal.requests).toHaveLength(1);
  });

  it.each([
    'deposit_held',
    'deposit_pending',
    'cancelled',
    'refunded',
    'partially_refunded',
    'deposit_needs_review',
    'awaiting_deposit',
  ] as const)(
    'R1: refuses to charge a %s booking',
    async (status) => {
      const store = createMemoryBookingStore();
      const booking = bookingWithWallet(store);
      store.save({ ...booking, status });
      const paypal = stubPayPal();
      await expect(chargeSavedWallet(paypal, store, booking.id, {}, NOW)).rejects.toMatchObject({
        code: 'invalid_state',
      });
      expect(paypal.requests).toHaveLength(0);
    },
  );

  it('R8: wallet charge and hold capture can never both take the deposit, in either order', async () => {
    const store = createMemoryBookingStore();
    // Wallet first, while the hold is still open: refused, so the later capture is the only charge.
    const held = bookingWithWallet(store);
    store.save({ ...held, status: 'deposit_held', hold: { ...held.hold!, capture: undefined, authorizationStatus: 'CREATED' } });
    const paypal = stubPayPal(walletCharged('6.00'));
    await expect(chargeSavedWallet(paypal, store, held.id, {}, NOW)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(paypal.requests).toHaveLength(0);

    // Capture first, then the wallet for the rest: the hold can't be captured again afterwards.
    const noShow = bookingWithWallet(store);
    await chargeSavedWallet(paypal, store, noShow.id, {}, NOW);
    await expect(
      captureDeposit(paypal.payments, store, noShow.id, { reason: 'completed' }, NOW),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    expect(paypal.requests).toHaveLength(1);
    const saved = store.get(noShow.id)!;
    expect(saved.hold!.capture!.amountCents + saved.hold!.walletCharges![0].amountCents).toBe(1000);
  });

  it('R1: the captured deposit counts toward the limit', async () => {
    const store = createMemoryBookingStore();
    const capture = (amountCents: number) => ({
      captureId: 'CAP-1',
      amountCents,
      status: 'COMPLETED',
      reason: 'no_show' as const,
      capturedAt: NOW.toISOString(),
    });
    const full = bookingWithWallet(store);
    store.save({ ...full, status: 'completed', hold: { ...full.hold!, capture: capture(1000) } });
    const partial = bookingWithWallet(store);
    store.save({ ...partial, status: 'no_show_charged', hold: { ...partial.hold!, capture: capture(400) } });
    const paypal = stubPayPal(walletCharged('6.00'));

    await expect(chargeSavedWallet(paypal, store, full.id, {}, NOW)).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(
      chargeSavedWallet(paypal, store, partial.id, { amountCents: 601 }, NOW),
    ).rejects.toMatchObject({ code: 'invalid_amount' });
    // Without an amount, it charges what is left of the deposit.
    const result = await chargeSavedWallet(paypal, store, partial.id, {}, NOW);
    expect(paypal.requests).toHaveLength(1);
    expect(paypal.requests[0].body.purchase_units[0].amount.value).toBe('6.00');
    expect(result.hold!.walletCharges).toMatchObject([{ amountCents: 600 }]);
  });

  it.each([0, 1001, 2.5])('rejects a charge of %s cents', async (cents) => {
    const store = createMemoryBookingStore();
    const booking = bookingWithWallet(store);
    const paypal = stubPayPal();
    await expect(
      chargeSavedWallet(paypal, store, booking.id, { amountCents: cents }, NOW),
    ).rejects.toMatchObject({ code: 'invalid_amount', httpStatus: 400 });
    expect(paypal.requests).toHaveLength(0);
  });

  it('a charge PayPal wants the customer present for (PAYER_ACTION_REQUIRED) is declined and retried with a fresh id', async () => {
    const store = createMemoryBookingStore();
    const booking = bookingWithWallet(store);
    const paypal = stubPayPal(walletCharged('4.00', 'PAYER_ACTION_REQUIRED', 'NONE'), walletCharged('4.00'));

    await expect(
      chargeSavedWallet(paypal, store, booking.id, { amountCents: 400 }, NOW),
    ).rejects.toMatchObject({ code: 'declined', httpStatus: 402 });
    expect(store.get(booking.id)!.hold!.walletCharges).toBeUndefined();

    await chargeSavedWallet(paypal, store, booking.id, { amountCents: 400 }, NOW);
    expect(paypal.requests.map((r) => r.headers['paypal-request-id'])).toEqual([
      `slotkeeper-wallet_charge-${booking.id}-1-1`,
      `slotkeeper-wallet_charge-${booking.id}-1-2`,
    ]);
  });

  it('after an unknown outcome, blocks other money actions and replays with the same id and amount', async () => {
    const store = createMemoryBookingStore();
    const booking = bookingWithWallet(store);
    const paypal = stubPayPal(networkDrop(), walletCharged('4.00'));

    await expect(
      chargeSavedWallet(paypal, store, booking.id, { amountCents: 400 }, NOW),
    ).rejects.toMatchObject({ code: 'network_error' });
    expect(store.get(booking.id)!.hold!.pendingAction).toMatchObject({ kind: 'wallet_charge', amountCents: 400 });

    await expect(
      refundDeposit(paypal.payments, store, booking.id, { amountCents: 100 }, NOW),
    ).rejects.toMatchObject({ code: 'pending_action' });

    const result = await chargeSavedWallet(paypal, store, booking.id, {}, NOW);
    expect(paypal.requests[1].headers['paypal-request-id']).toBe(paypal.requests[0].headers['paypal-request-id']);
    expect(paypal.requests[1].body.purchase_units[0].amount.value).toBe('4.00');
    expect(result.hold!.pendingAction).toBeUndefined();
    expect(result.hold!.walletCharges).toHaveLength(1);
  });

  it('a charge for a different amount than requested goes to staff review', async () => {
    const store = createMemoryBookingStore();
    const booking = bookingWithWallet(store);
    const paypal = stubPayPal(walletCharged('5.00'));
    await expect(
      chargeSavedWallet(paypal, store, booking.id, { amountCents: 400 }, NOW),
    ).rejects.toMatchObject({ code: 'amount_mismatch' });
    expect(store.get(booking.id)).toMatchObject({
      status: 'deposit_needs_review',
      hold: { walletCharges: [{ captureId: 'CAP-W1', amountCents: 500 }] },
    });
  });
});

describe('publicBooking', () => {
  it('hides the vault and PayPal customer ids from customer-facing responses', () => {
    const store = createMemoryBookingStore();
    const booking = bookingWithWallet(store);
    const shown = publicBooking(booking);
    expect(shown.hold!.savedWallet).toEqual({ status: 'VAULTED', savedAt: NOW.toISOString() });
    expect(JSON.stringify(shown)).not.toContain('VAULT-1');
    expect(JSON.stringify(shown)).not.toContain('CUST-1');
    // The stored booking is unchanged.
    expect(store.get(booking.id)!.hold!.savedWallet!.vaultId).toBe('VAULT-1');
  });
});
