import { Client, Environment, OrdersController, PaymentsController } from '@paypal/paypal-server-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBooking } from '@/lib/booking/bookings';
import { createMemoryBookingStore, type Booking, type BookingStatus, type BookingStore, type DepositHold } from '@/lib/booking/store';
import { buildClientConfiguration } from '@/lib/paypal/client';
import { captureDeposit, chargeSavedWallet, refundDeposit } from '@/lib/paypal/deposit-actions';
import { authorizeDeposit, createDepositOrder } from '@/lib/paypal/deposits';
import { isDefiniteRefusal } from '@/lib/paypal/errors';
import { createRestTransport } from '@/lib/paypal/rest';
import { stubPayPal, type Reply } from '../helpers/paypal-stub';

// Fixed clock: tests never depend on the real date.
const NOW = new Date('2026-11-01T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const hoursBefore = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();

const settings = { environment: Environment.Sandbox, clientId: 'id', clientSecret: 'super-secret', timeoutMs: 12_000 };

/** The production client configuration over a stub adapter, so the real retry rules run. */
function realConfigClient(respond: (attempt: number) => { status: number; body?: unknown } | Error) {
  const seen: Array<{ method: string; timeout: unknown; url: string }> = [];
  const config = buildClientConfiguration(settings);
  const client = new Client({
    ...config,
    clientCredentialsAuthCredentials: {
      ...config.clientCredentialsAuthCredentials!,
      oAuthToken: { accessToken: 'seeded-token', tokenType: 'Bearer', expiry: BigInt(Math.floor(Date.now() / 1000) + 3600) },
    },
    unstable_httpClientOptions: {
      adapter: async (request: any) => {
        seen.push({ method: String(request.method).toUpperCase(), timeout: request.timeout, url: request.url });
        const reply = respond(seen.length);
        if (reply instanceof Error) throw reply;
        return {
          data: reply.body === undefined ? '' : JSON.stringify(reply.body),
          status: reply.status,
          statusText: '',
          headers: { 'content-type': 'application/json' },
          config: request,
        };
      },
    },
  });
  return { client, seen };
}

function booking(store: BookingStore, status: BookingStatus, hold: Partial<DepositHold>): Booking {
  const created = createBooking(store, { serviceId: 'haircut', customerName: 'Ana', startsAt: '2026-11-02T10:00:00.000Z' }, new Date('2026-11-01T00:00:00.000Z'));
  const saved: Booking = {
    ...created,
    status,
    hold: { paypalOrderId: 'ORDER-1', orderAttempt: 1, orderCreatedAt: NOW.toISOString(), authorizationId: 'AUTH-1', ...hold },
  };
  store.save(saved);
  return saved;
}

const capture = { captureId: 'CAP-1', amountCents: 400, status: 'COMPLETED', reason: 'no_show' as const, capturedAt: NOW.toISOString() };
const wallet = { vaultId: 'VAULT-1', status: 'VAULTED', customerId: 'CUST-1', savedAt: NOW.toISOString() };
const pendingWallet = (since: string): Partial<DepositHold> => ({
  capture,
  savedWallet: wallet,
  pendingAction: { kind: 'wallet_charge', requestId: 'slotkeeper-wallet_charge-x-1', amountCents: 600, since },
});
const walletOrder = (bookingId: string): Reply => ({
  status: 201,
  body: {
    id: 'ORDER-W',
    status: 'COMPLETED',
    purchase_units: [{ reference_id: bookingId, payments: { captures: [{ id: 'CAP-W', status: 'COMPLETED', amount: { currency_code: 'USD', value: '6.00' } }] } }],
  },
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('SDK client configuration', () => {
  it('leaves SDK logging off, so requests and their headers are never printed', () => {
    expect(buildClientConfiguration(settings)).not.toHaveProperty('logging');
  });

  it('sends every request with the configured timeout', async () => {
    const { client, seen } = realConfigClient(() => ({ status: 204 }));
    await new PaymentsController(client).voidPayment({ authorizationId: 'AUTH-1', paypalRequestId: 'r' });
    expect(seen[0].timeout).toBe(12_000);
  });

  it('retries a failed GET once', async () => {
    const { client, seen } = realConfigClient((n) =>
      n === 1 ? { status: 503, body: { name: 'SERVICE_UNAVAILABLE' } } : { status: 200, body: { id: 'AUTH-1', status: 'CREATED' } },
    );
    const { result } = await new PaymentsController(client).getAuthorizedPayment({ authorizationId: 'AUTH-1' });
    expect(result.id).toBe('AUTH-1');
    expect(seen.map((r) => r.method)).toEqual(['GET', 'GET']);
  }, 15_000);

  it.each([
    ['capture', (p: PaymentsController) => p.captureAuthorizedPayment({ authorizationId: 'A', paypalRequestId: 'r', body: {} })],
    ['refund', (p: PaymentsController) => p.refundCapturedPayment({ captureId: 'C', paypalRequestId: 'r', body: {} })],
    ['void', (p: PaymentsController) => p.voidPayment({ authorizationId: 'A', paypalRequestId: 'r' })],
    ['reauthorize', (p: PaymentsController) => p.reauthorizePayment({ authorizationId: 'A', paypalRequestId: 'r', body: {} })],
  ])('never re-sends a %s by itself, on a 503 or a timeout', async (_name, call) => {
    for (const failure of [{ status: 503 }, Object.assign(new Error('timeout of 12000ms exceeded'), { code: 'ECONNABORTED' })]) {
      const { client, seen } = realConfigClient(() => failure);
      await expect(call(new PaymentsController(client))).rejects.toBeDefined();
      expect(seen).toHaveLength(1);
    }
  });

  it.each([
    ['create', (o: OrdersController) => o.createOrder({ paypalRequestId: 'r', body: { intent: 'CAPTURE' as never, purchaseUnits: [] } })],
    ['authorize', (o: OrdersController) => o.authorizeOrder({ id: 'O', paypalRequestId: 'r' })],
  ])('never re-sends an order %s by itself, on a 503 or a timeout', async (_name, call) => {
    for (const failure of [{ status: 503 }, Object.assign(new Error('timeout of 12000ms exceeded'), { code: 'ECONNABORTED' })]) {
      const { client, seen } = realConfigClient(() => failure);
      await expect(call(new OrdersController(client))).rejects.toBeDefined();
      expect(seen).toHaveLength(1);
    }
  });
});

describe('isDefiniteRefusal', () => {
  it.each([
    [400, undefined, true],
    [401, undefined, true],
    [422, 'INSTRUMENT_DECLINED', true],
    [429, undefined, true],
    [408, undefined, false],
    [409, undefined, false],
    [422, 'PREVIOUS_REQUEST_IN_PROGRESS', false],
    [500, undefined, false],
  ])('status %s issue %s -> %s', (status, issue, expected) => {
    expect(isDefiniteRefusal({ status, issue })).toBe(expected);
  });

  it.each([
    [422, true],
    [400, false],
    [401, false],
    [403, false],
    [429, false],
  ])('on a replay, status %s -> %s', (status, expected) => {
    expect(isDefiniteRefusal({ status }, true)).toBe(expected);
  });
});

describe('a replay refused before PayPal looked at it settles nothing', () => {
  const unreachable = (): Reply => ({ throw: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
  const REFUSALS: Array<[string, Reply]> = [
    ['429', { status: 429, body: { name: 'RATE_LIMIT_REACHED' } }],
    ['401', { status: 401, body: { name: 'AUTHENTICATION_FAILURE' } }],
  ];
  const paid = (value: string, id: string): Reply => ({ status: 201, body: { id, status: 'COMPLETED', amount: { currency_code: 'USD', value } } });

  it.each(REFUSALS)('capture: lost answer, replay answered %s, third call keeps the first id', async (_name, refusal) => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'deposit_held', {});
    const { payments, requests } = stubPayPal(unreachable(), refusal, paid('10.00', 'CAP-1'));
    await expect(captureDeposit(payments, store, b.id, { reason: 'completed' }, NOW)).rejects.toMatchObject({ code: 'network_error' });
    await expect(captureDeposit(payments, store, b.id, { reason: 'completed' }, NOW)).rejects.toMatchObject({ code: 'paypal_error', httpStatus: 502 });
    expect(store.get(b.id)!.hold!.pendingAction?.kind).toBe('capture');
    await captureDeposit(payments, store, b.id, { reason: 'completed' }, NOW);
    expect(new Set(requests.map((r) => r.headers['paypal-request-id'])).size).toBe(1);
  });

  it.each(REFUSALS)('refund: lost answer, replay answered %s, third call keeps the first id', async (_name, refusal) => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'no_show_charged', { capture });
    const { payments, requests } = stubPayPal(unreachable(), refusal, paid('1.00', 'REF-1'));
    await expect(refundDeposit(payments, store, b.id, { amountCents: 100 }, NOW)).rejects.toMatchObject({ code: 'network_error' });
    await expect(refundDeposit(payments, store, b.id, {}, NOW)).rejects.toMatchObject({ code: 'paypal_error', httpStatus: 502 });
    await refundDeposit(payments, store, b.id, {}, NOW);
    expect(new Set(requests.map((r) => r.headers['paypal-request-id'])).size).toBe(1);
  });

  it.each(REFUSALS)('wallet charge: lost answer, replay answered %s, third call keeps the first id', async (_name, refusal) => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'no_show_charged', { capture, savedWallet: wallet });
    const { orders, vault, requests } = stubPayPal(unreachable(), refusal, walletOrder(b.id));
    await expect(chargeSavedWallet({ orders, vault }, store, b.id, { amountCents: 600 }, NOW)).rejects.toMatchObject({ code: 'network_error' });
    await expect(chargeSavedWallet({ orders, vault }, store, b.id, {}, NOW)).rejects.toMatchObject({ code: 'paypal_error', httpStatus: 502 });
    await chargeSavedWallet({ orders, vault }, store, b.id, {}, NOW);
    expect(new Set(requests.map((r) => r.headers['paypal-request-id'])).size).toBe(1);
    expect(store.get(b.id)!.hold!.walletCharges).toHaveLength(1);
  });

  it.each(REFUSALS)('authorize: lost answer, replay answered %s, stays unknown with the same id', async (_name, refusal) => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'awaiting_deposit', { authorizationId: undefined });
    const { orders, requests } = stubPayPal(unreachable(), refusal);
    await expect(authorizeDeposit(orders, store, b.id, 'ORDER-1', NOW)).rejects.toMatchObject({ code: 'network_error' });
    await expect(authorizeDeposit(orders, store, b.id, 'ORDER-1', NOW)).rejects.toMatchObject({ code: 'paypal_error', httpStatus: 502 });
    expect(store.get(b.id)!.hold!.authorizeOutcomeUnknown).toBe(true);
    expect(requests[1].headers['paypal-request-id']).toBe(requests[0].headers['paypal-request-id']);
  });

  it('a 422 business answer to a replay does settle it', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'deposit_held', {});
    const declined: Reply = { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'TRANSACTION_REFUSED' }] } };
    const { payments } = stubPayPal(unreachable(), declined);
    await expect(captureDeposit(payments, store, b.id, { reason: 'completed' }, NOW)).rejects.toMatchObject({ code: 'network_error' });
    await expect(captureDeposit(payments, store, b.id, { reason: 'completed' }, NOW)).rejects.toMatchObject({ code: 'declined' });
    expect(store.get(b.id)!.hold!.pendingAction).toBeUndefined();
  });
});

describe('an answer that does not prove nothing happened keeps the same PayPal-Request-Id', () => {
  const inProgress = (): Reply => ({
    status: 422,
    body: { name: 'UNPROCESSABLE_ENTITY', debug_id: 'dbg', details: [{ issue: 'PREVIOUS_REQUEST_IN_PROGRESS' }] },
  });

  it.each([
    ['408', { status: 408 } as Reply],
    ['409', { status: 409, body: { name: 'CONFLICT' } } as Reply],
    ['PREVIOUS_REQUEST_IN_PROGRESS', inProgress()],
  ])('capture answered %s stays pending and replays with the same id', async (_name, reply) => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'deposit_held', {});
    const { payments, requests } = stubPayPal(reply, { status: 201, body: { id: 'CAP-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '10.00' } } });

    await expect(captureDeposit(payments, store, b.id, { reason: 'completed' }, NOW)).rejects.toMatchObject({
      code: 'paypal_error',
      httpStatus: 502,
      message: expect.stringContaining('will not happen twice'),
    });
    expect(store.get(b.id)!.hold!.pendingAction?.kind).toBe('capture');

    await captureDeposit(payments, store, b.id, { reason: 'completed' }, NOW);
    expect(requests[1].headers['paypal-request-id']).toBe(requests[0].headers['paypal-request-id']);
  });

  it('authorize answered 409 is replayed with the same id before any new order', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'awaiting_deposit', { authorizationId: undefined });
    const { orders, requests } = stubPayPal({ status: 409, body: { name: 'CONFLICT' } }, { status: 409, body: { name: 'CONFLICT' } });

    await expect(authorizeDeposit(orders, store, b.id, 'ORDER-1', NOW)).rejects.toMatchObject({ code: 'paypal_error', httpStatus: 502 });
    expect(store.get(b.id)!.hold!.authorizeOutcomeUnknown).toBe(true);

    await expect(authorizeDeposit(orders, store, b.id, 'ORDER-1', NOW)).rejects.toMatchObject({ code: 'paypal_error', httpStatus: 502 });
    expect(requests[1].url).toBe(requests[0].url);
    expect(requests[1].headers['paypal-request-id']).toBe(requests[0].headers['paypal-request-id']);
  });
});

describe('replaying after PayPal has forgotten the request id', () => {
  it('a wallet charge inside the window is replayed with the same id', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'no_show_charged', pendingWallet(hoursBefore(4)));
    const { orders, vault, requests } = stubPayPal(walletOrder(b.id));
    await chargeSavedWallet({ orders, vault }, store, b.id, {}, NOW);
    expect(requests[0].headers['paypal-request-id']).toBe('slotkeeper-wallet_charge-x-1');
  });

  it('a wallet charge past the window goes to review and never reaches PayPal: it would charge twice', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'no_show_charged', pendingWallet(hoursBefore(6)));
    const { orders, vault, requests } = stubPayPal();
    await expect(chargeSavedWallet({ orders, vault }, store, b.id, {}, NOW)).rejects.toMatchObject({ code: 'needs_review', httpStatus: 409 });
    expect(requests).toHaveLength(0);
    expect(store.get(b.id)!.status).toBe('deposit_needs_review');
    expect(store.get(b.id)!.hold!.pendingAction?.kind).toBe('wallet_charge');
  });

  const unknownAuthorize = (since: string): Partial<DepositHold> => ({ authorizationId: undefined, authorizeOutcomeUnknown: true, authorizeUnknownSince: since });

  it('an authorize inside the window answered 404 stays unknown and keeps its first time', async () => {
    const store = createMemoryBookingStore();
    const since = hoursBefore(4);
    const b = booking(store, 'awaiting_deposit', unknownAuthorize(since));
    const { orders } = stubPayPal({ status: 404, body: { name: 'RESOURCE_NOT_FOUND' } });
    await expect(authorizeDeposit(orders, store, b.id, 'ORDER-1', NOW)).rejects.toMatchObject({ code: 'paypal_error', httpStatus: 502 });
    expect(store.get(b.id)!.hold).toMatchObject({ authorizeOutcomeUnknown: true, authorizeUnknownSince: since });
  });

  it('an authorize past the window goes to review without calling PayPal, so the booking is not stuck', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'awaiting_deposit', unknownAuthorize(hoursBefore(6)));
    const { orders, requests } = stubPayPal();
    await expect(authorizeDeposit(orders, store, b.id, 'ORDER-1', NOW)).rejects.toMatchObject({ code: 'needs_review', httpStatus: 409 });
    expect(requests).toHaveLength(0);
    expect(store.get(b.id)!.status).toBe('deposit_needs_review');
    expect(store.get(b.id)!.hold).toMatchObject({ authorizeOutcomeUnknown: false, orderSpent: true });
  });

  it('a refund past the 45-day retention goes to review', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'no_show_charged', {
      capture,
      pendingAction: { kind: 'refund', requestId: 'r', amountCents: 100, since: hoursBefore(45 * 24) },
    });
    const { payments, requests } = stubPayPal();
    await expect(refundDeposit(payments, store, b.id, {}, NOW)).rejects.toMatchObject({ code: 'needs_review' });
    expect(requests).toHaveLength(0);
  });
});

describe('saved wallet lookup', () => {
  const unvaulted = (store: BookingStore) =>
    booking(store, 'no_show_charged', { capture, savedWallet: { status: 'APPROVED', customerId: 'CUST-1', savedAt: NOW.toISOString() } });

  it('only a 404 means there is no saved wallet', async () => {
    const store = createMemoryBookingStore();
    const b = unvaulted(store);
    const { orders, vault } = stubPayPal({ status: 404, body: { name: 'RESOURCE_NOT_FOUND' } });
    await expect(chargeSavedWallet({ orders, vault }, store, b.id, {}, NOW)).rejects.toMatchObject({ code: 'invalid_state', httpStatus: 409 });
  });

  it.each([403, 429])('a %s is a PayPal problem, not a missing wallet', async (status) => {
    const store = createMemoryBookingStore();
    const b = unvaulted(store);
    const { orders, vault } = stubPayPal({ status, body: { name: 'NOPE' } });
    await expect(chargeSavedWallet({ orders, vault }, store, b.id, {}, NOW)).rejects.toMatchObject({ code: 'paypal_error', httpStatus: 502 });
  });
});

describe('REST transport (Payouts)', () => {
  it('a timeout or dropped connection never leaks the token into the error', async () => {
    const transport = createRestTransport({
      baseUrl: 'https://api-m.sandbox.paypal.com',
      getToken: async () => 'secret-bearer-token',
      timeoutMs: 1000,
      fetchFn: (async () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError',
          config: { headers: { Authorization: 'Bearer secret-bearer-token' } },
        });
      }) as typeof fetch,
    });
    const err = await transport.request({ method: 'POST', path: '/v1/payments/payouts', requestId: 'r' }).catch((e: Error) => e);
    expect(err).toMatchObject({ name: 'PayPalUnreachableError' });
    expect(JSON.stringify([err, (err as Error).message, (err as Error).stack, (err as Error).cause])).not.toContain('secret-bearer-token');
  });

  it('a failed token fetch never leaks the Basic header', async () => {
    const transport = createRestTransport({
      baseUrl: 'https://api-m.sandbox.paypal.com',
      getToken: async () => {
        throw Object.assign(new Error('Request failed\nAuthorization: Basic c2VjcmV0'), { config: { headers: { Authorization: 'Basic c2VjcmV0' } } });
      },
      timeoutMs: 1000,
      fetchFn: (async () => new Response('{}')) as typeof fetch,
    });
    const err = await transport.request({ method: 'GET', path: '/v1/x' }).catch((e: Error) => e);
    expect(err).toMatchObject({ name: 'PayPalUnreachableError' });
    expect(JSON.stringify([err, (err as Error).message, (err as Error).stack])).not.toContain('c2VjcmV0');
  });
});

describe('credentials in logs', () => {
  it('a money call failing every way logs neither the secret nor the bearer token', async () => {
    const store = createMemoryBookingStore();
    const leakyDrop = () =>
      Object.assign(new Error('socket hang up'), {
        code: 'ECONNRESET',
        config: { headers: { Authorization: 'Bearer leaked-token' } },
        request: { headers: { Authorization: 'Basic leaked-secret' } },
      });
    const { payments } = stubPayPal({ throw: leakyDrop() }, { status: 500, body: { name: 'INTERNAL' } }, { status: 401, body: { name: 'AUTHENTICATION_FAILURE' } });
    const errors: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const b = booking(store, 'deposit_held', {});
      await captureDeposit(payments, store, b.id, { reason: 'completed' }, NOW).catch((e: unknown) => errors.push(e));
    }
    expect(errors).toHaveLength(3);
    const seen = JSON.stringify([vi.mocked(console.error).mock.calls, errors]);
    expect(seen).not.toContain('leaked-token');
    expect(seen).not.toContain('leaked-secret');
    expect(seen).not.toContain('Authorization');
  });

  it('createDepositOrder surfaces a network failure without request details', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'awaiting_deposit', { authorizationId: undefined, orderCreatedAt: '2026-10-01T00:00:00.000Z' });
    const drop = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET', config: { headers: { Authorization: 'Bearer leaked-token' } } });
    const { orders } = stubPayPal({ throw: drop });
    const err = await createDepositOrder(orders, store, b.id, { returnUrl: 'https://a.test/r', cancelUrl: 'https://a.test/c' }, NOW).catch((e: Error) => e);
    expect(err).toMatchObject({ code: 'network_error' });
    expect(JSON.stringify([err, vi.mocked(console.error).mock.calls])).not.toContain('leaked-token');
  });
});
