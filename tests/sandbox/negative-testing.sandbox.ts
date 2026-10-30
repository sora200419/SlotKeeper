import { Environment, OrdersController, PaymentsController } from '@paypal/paypal-server-sdk';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBooking } from '@/lib/booking/bookings';
import { createMemoryBookingStore, type Booking, type BookingStatus, type BookingStore } from '@/lib/booking/store';
import { createPayPalClient } from '@/lib/paypal/client';
import { readPayPalSettings } from '@/lib/paypal/config';
import { captureDeposit, refundDeposit, voidDeposit } from '@/lib/paypal/deposit-actions';
import { authorizeDeposit } from '@/lib/paypal/deposits';
import { mockedOrders, mockedPayments } from '../helpers/negative-testing';

/*
 * Opt-in: talks to the real PayPal sandbox, so `npm test` never runs it. See README ("Sandbox negative
 * tests"). Every call carries PayPal-Mock-Response and targets ids that don't exist, so no money or
 * real order is involved. Needs Negative Testing switched on for the sandbox business account.
 *
 * Each code below was checked against its endpoint: a code the endpoint doesn't support answers an
 * empty 403 (INSTRUMENT_DECLINED on capture, TRANSACTION_REFUSED on refund, AUTHORIZATION_EXPIRED on
 * void). The SDK's reauthorizePayment can't send the header, so only the stub tests cover it.
 */
const ENABLED = process.env.PAYPAL_SANDBOX_TESTS === '1';

// Fixed clock: tests never depend on the real date.
const NOW = new Date('2026-11-01T00:00:00.000Z');
const FAKE_AUTH = 'FAKEAUTH';
const FAKE_CAPTURE = 'FAKECAPTURE';
const FAKE_ORDER = 'FAKEORDER';

function fixture(store: BookingStore, status: BookingStatus, captured: boolean): Booking {
  const booking = createBooking(store, { serviceId: 'haircut', customerName: 'Ana', startsAt: '2026-11-02T10:00:00.000Z' }, NOW);
  const saved: Booking = {
    ...booking,
    status,
    hold: {
      paypalOrderId: FAKE_ORDER,
      orderAttempt: 1,
      orderCreatedAt: NOW.toISOString(),
      ...(status === 'awaiting_deposit'
        ? {}
        : {
            authorizationId: FAKE_AUTH,
            authorizationStatus: 'CREATED',
            heldAt: NOW.toISOString(),
            capture: captured
              ? { captureId: FAKE_CAPTURE, amountCents: 1000, status: 'COMPLETED', reason: 'completed' as const, capturedAt: NOW.toISOString() }
              : undefined,
          }),
    },
  };
  store.save(saved);
  return saved;
}

describe.skipIf(!ENABLED)('PayPal sandbox negative testing', () => {
  let payments: PaymentsController;
  let orders: OrdersController;

  beforeAll(() => {
    const settings = readPayPalSettings();
    // These calls carry fake ids and mock headers; they have no business reaching live PayPal.
    if (settings.environment !== Environment.Sandbox) throw new Error('Sandbox tests refuse to run against production.');
    const client = createPayPalClient(settings);
    payments = new PaymentsController(client);
    orders = new OrdersController(client);
  });

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it.each([
    ['TRANSACTION_REFUSED', 'declined', 402],
    ['PAYER_CANNOT_PAY', 'declined', 402],
    ['AUTHORIZATION_DENIED', 'declined', 402],
    ['AUTHORIZATION_EXPIRED', 'authorization_expired', 409],
    ['AUTHORIZATION_VOIDED', 'invalid_state', 409],
    ['AUTHORIZATION_ALREADY_CAPTURED', 'needs_review', 409],
    ['MAX_CAPTURE_COUNT_EXCEEDED', 'needs_review', 409],
  ])('capture answered %s becomes %s', async (mock, code, httpStatus) => {
    const store = createMemoryBookingStore();
    const booking = fixture(store, 'deposit_held', false);
    await expect(
      captureDeposit(mockedPayments(payments, mock), store, booking.id, { reason: 'no_show', amountCents: 400 }, NOW),
    ).rejects.toMatchObject({ code, httpStatus, paypal: { issue: mock } });
    expect(store.get(booking.id)!.hold!.capture).toBeUndefined();
    expect(store.get(booking.id)!.hold!.pendingAction).toBeUndefined();
  });

  it.each([
    ['PREVIOUSLY_VOIDED', 'invalid_state', 409, 'deposit_held'],
    ['PREVIOUSLY_CAPTURED', 'needs_review', 409, 'deposit_needs_review'],
  ])('void answered %s becomes %s', async (mock, code, httpStatus, status) => {
    const store = createMemoryBookingStore();
    const booking = fixture(store, 'deposit_held', false);
    await expect(voidDeposit(mockedPayments(payments, mock), store, booking.id, NOW)).rejects.toMatchObject({
      code,
      httpStatus,
      paypal: { issue: mock },
    });
    expect(store.get(booking.id)!.status).toBe(status);
  });

  it.each([
    ['REFUND_FAILED_INSUFFICIENT_FUNDS', 'declined', 402],
    ['REFUND_NOT_ALLOWED', 'paypal_error', 422],
    ['CAPTURE_FULLY_REFUNDED', 'paypal_error', 422],
  ])('refund answered %s becomes %s', async (mock, code, httpStatus) => {
    const store = createMemoryBookingStore();
    const booking = fixture(store, 'completed', true);
    await expect(
      refundDeposit(mockedPayments(payments, mock), store, booking.id, { amountCents: 100 }, NOW),
    ).rejects.toMatchObject({ code, httpStatus, paypal: { issue: mock } });
    expect(store.get(booking.id)!.hold!.refunds).toBeUndefined();
  });

  it.each([
    ['INSTRUMENT_DECLINED', 'declined', 402],
    ['TRANSACTION_REFUSED', 'declined', 402],
    ['PAYER_CANNOT_PAY', 'declined', 402],
    ['ORDER_NOT_APPROVED', 'not_approved', 409],
  ])('authorize answered %s becomes %s', async (mock, code, httpStatus) => {
    const store = createMemoryBookingStore();
    const booking = fixture(store, 'awaiting_deposit', false);
    await expect(authorizeDeposit(mockedOrders(orders, mock), store, booking.id, FAKE_ORDER, NOW)).rejects.toMatchObject({
      code,
      httpStatus,
      paypal: { issue: mock },
    });
    expect(store.get(booking.id)!.hold!.authorizationId).toBeUndefined();
    expect(Boolean(store.get(booking.id)!.hold!.orderSpent)).toBe(code === 'declined');
  });
});
