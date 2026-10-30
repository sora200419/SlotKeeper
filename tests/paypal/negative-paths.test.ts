import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBooking } from '@/lib/booking/bookings';
import { createMemoryBookingStore, type Booking, type BookingStatus, type BookingStore, type DepositHold } from '@/lib/booking/store';
import { captureDeposit, reauthorizeDeposit, refundDeposit, voidDeposit } from '@/lib/paypal/deposit-actions';
import { authorizeDeposit, createDepositOrder } from '@/lib/paypal/deposits';
import { mockedOrders, mockedPayments, mockHeader } from '../helpers/negative-testing';
import { stubPayPal, type Reply } from '../helpers/paypal-stub';

// Fixed clock: tests never depend on the real date.
const NOW = new Date('2026-11-01T00:00:00.000Z');

function booking(store: BookingStore, status: BookingStatus, hold: Partial<DepositHold>): Booking {
  const created = createBooking(store, { serviceId: 'haircut', customerName: 'Ana', startsAt: '2026-11-02T10:00:00.000Z' }, NOW);
  const saved: Booking = {
    ...created,
    status,
    hold: { paypalOrderId: 'ORDER-1', orderAttempt: 1, orderCreatedAt: NOW.toISOString(), ...hold },
  };
  store.save(saved);
  return saved;
}

const held = (store: BookingStore) => booking(store, 'deposit_held', { authorizationId: 'AUTH-1', authorizationStatus: 'CREATED', heldAt: NOW.toISOString() });
const captured = (store: BookingStore) =>
  booking(store, 'completed', {
    authorizationId: 'AUTH-1',
    capture: { captureId: 'CAP-1', amountCents: 1000, status: 'COMPLETED', reason: 'completed', capturedAt: NOW.toISOString() },
  });

const unprocessable = (issue: string): Reply => ({
  status: 422,
  body: { name: 'UNPROCESSABLE_ENTITY', message: 'no', debug_id: 'dbg-1', details: [{ issue }] },
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('declined money actions leave nothing recorded', () => {
  // Issue names are the ones the sandbox really answered (tests/sandbox/negative-testing.sandbox.ts).
  it.each(['TRANSACTION_REFUSED', 'PAYER_CANNOT_PAY', 'AUTHORIZATION_DENIED'])('capture answered %s is declined and records nothing', async (issue) => {
    const store = createMemoryBookingStore();
    const b = held(store);
    const { payments, requests } = stubPayPal(unprocessable(issue));
    await expect(captureDeposit(payments, store, b.id, { reason: 'no_show', amountCents: 400 }, NOW)).rejects.toMatchObject({
      code: 'declined',
      httpStatus: 402,
      message: 'PayPal declined the request to capture the deposit.',
      paypal: { issue },
    });
    expect(requests[0].body).toMatchObject({ amount: { value: '4.00' }, final_capture: true });
    const saved = store.get(b.id)!;
    expect(saved.status).toBe('deposit_held');
    expect(saved.hold!.capture).toBeUndefined();
    expect(saved.hold!.pendingAction).toBeUndefined();
    expect(saved.hold!.actionAttempts?.capture).toBe(2);
  });

  it('a refund PayPal refuses for lack of funds is declined and records no refund', async () => {
    const store = createMemoryBookingStore();
    const b = captured(store);
    const { payments } = stubPayPal(unprocessable('REFUND_FAILED_INSUFFICIENT_FUNDS'));
    await expect(refundDeposit(payments, store, b.id, { amountCents: 100 }, NOW)).rejects.toMatchObject({ code: 'declined', httpStatus: 402 });
    expect(store.get(b.id)!.status).toBe('completed');
    expect(store.get(b.id)!.hold!.refunds).toBeUndefined();
  });

  it('a reauthorization PayPal declines keeps the old hold', async () => {
    const store = createMemoryBookingStore();
    const b = held(store);
    const { payments } = stubPayPal(unprocessable('TRANSACTION_REFUSED'));
    await expect(reauthorizeDeposit(payments, store, b.id, NOW)).rejects.toMatchObject({ code: 'declined' });
    expect(store.get(b.id)!.hold).toMatchObject({ authorizationId: 'AUTH-1' });
    expect(store.get(b.id)!.hold!.previousAuthorizationIds).toBeUndefined();
  });
});

describe('a declined authorize', () => {
  it.each(['INSTRUMENT_DECLINED', 'TRANSACTION_REFUSED', 'PAYER_CANNOT_PAY'])('%s retires the order, so the next checkout gets a new one', async (issue) => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'awaiting_deposit', {});
    const { orders, requests } = stubPayPal(unprocessable(issue), { status: 201, body: { id: 'ORDER-2', status: 'PAYER_ACTION_REQUIRED' } });
    await expect(authorizeDeposit(orders, store, b.id, 'ORDER-1', NOW)).rejects.toMatchObject({ code: 'declined', httpStatus: 402 });
    expect(store.get(b.id)!.hold).toMatchObject({ orderSpent: true });

    const next = await createDepositOrder(orders, store, b.id, { returnUrl: 'https://app.test/r', cancelUrl: 'https://app.test/c' }, NOW);
    expect(next.orderId).toBe('ORDER-2');
    expect(requests).toHaveLength(2);
  });
});

// AUTHORIZATION_EXPIRED on void and reauthorize is an assumed reply: the sandbox can't mock it there
// (void answers an empty 403, and the SDK can't send the header on reauthorize).
describe('an expired authorization', () => {
  it.each([
    ['void', (p: Parameters<typeof voidDeposit>[0], s: BookingStore, id: string) => voidDeposit(p, s, id, NOW)],
    ['reauthorize', (p: Parameters<typeof reauthorizeDeposit>[0], s: BookingStore, id: string) => reauthorizeDeposit(p, s, id, NOW)],
  ])('%s maps to authorization_expired and keeps the booking', async (_name, action) => {
    const store = createMemoryBookingStore();
    const b = held(store);
    const { payments } = stubPayPal(unprocessable('AUTHORIZATION_EXPIRED'));
    const err = await action(payments, store, b.id).catch((e: Error) => e);
    expect(err).toMatchObject({ code: 'authorization_expired', httpStatus: 409 });
    expect((err as Error).message).not.toContain('Reauthorize');
    expect(store.get(b.id)!.status).toBe('deposit_held');
    expect(store.get(b.id)!.hold!.pendingAction).toBeUndefined();
  });
});

describe('PayPal-Mock-Response helpers', () => {
  it('send the header on capture, void and refund, in the JSON form PayPal expects', async () => {
    const store = createMemoryBookingStore();
    const { payments, requests } = stubPayPal(unprocessable('X'), unprocessable('X'), unprocessable('X'));
    const mocked = mockedPayments(payments, 'X');
    await captureDeposit(mocked, store, held(store).id, { reason: 'completed' }, NOW).catch(() => undefined);
    await voidDeposit(mocked, store, held(store).id, NOW).catch(() => undefined);
    await refundDeposit(mocked, store, captured(store).id, {}, NOW).catch(() => undefined);
    expect(requests.map((r) => r.headers['paypal-mock-response'])).toEqual(Array(3).fill('{"mock_application_codes":"X"}'));
  });

  it('send it on authorize too', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'awaiting_deposit', {});
    const { orders, requests } = stubPayPal(unprocessable('INSTRUMENT_DECLINED'));
    await expect(authorizeDeposit(mockedOrders(orders, 'INSTRUMENT_DECLINED'), store, b.id, 'ORDER-1', NOW)).rejects.toMatchObject({ code: 'declined' });
    expect(requests[0].headers['paypal-mock-response']).toBe(mockHeader('INSTRUMENT_DECLINED'));
  });

  it('are not used by app code: an unwrapped call sends no mock header', async () => {
    const store = createMemoryBookingStore();
    const { payments, requests } = stubPayPal({ status: 204 });
    await voidDeposit(payments, store, held(store).id, NOW);
    expect(requests[0].headers['paypal-mock-response']).toBeUndefined();
  });
});
