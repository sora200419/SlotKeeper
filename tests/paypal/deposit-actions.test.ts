import {
  ArgumentsValidationError,
  Client,
  Environment,
  PaymentsController,
} from '@paypal/paypal-server-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBooking } from '@/lib/booking/bookings';
import {
  createMemoryBookingStore,
  type Booking,
  type BookingStatus,
  type BookingStore,
  type DepositHold,
} from '@/lib/booking/store';
import {
  captureDeposit,
  parseCents,
  type DepositPayments,
  reauthorizeDeposit,
  refundDeposit,
  voidDeposit,
} from '@/lib/paypal/deposit-actions';

// Fixed clock: tests never depend on the real date.
const NOW = new Date('2026-11-01T00:00:00.000Z');
const LATER = new Date('2026-11-05T00:00:00.000Z');
const API = 'https://api-m.sandbox.paypal.com';

type Reply = { status: number; body?: unknown } | { throw: Error };
type Captured = { method: string; url: string; headers: Record<string, string>; body: any };

/**
 * A real PaymentsController over a stub axios adapter (the SDK's `unstable_httpClientOptions` seam),
 * with a seeded OAuth token so no token request goes through the adapter.
 */
function stubPayments(...replies: Reply[]) {
  const requests: Captured[] = [];
  const queue = [...replies];
  const client = new Client({
    environment: Environment.Sandbox,
    clientCredentialsAuthCredentials: {
      oAuthClientId: 'dummy-id',
      oAuthClientSecret: 'dummy-secret',
      oAuthToken: {
        accessToken: 'seeded-token',
        tokenType: 'Bearer',
        expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      },
    },
    httpClientOptions: { retryConfig: { maxNumberOfRetries: 0 } },
    unstable_httpClientOptions: {
      adapter: async (config: any) => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(config.headers ?? {})) {
          headers[key.toLowerCase()] = String(value);
        }
        requests.push({
          method: String(config.method).toUpperCase(),
          url: config.url,
          headers,
          body: config.data ? JSON.parse(config.data) : undefined,
        });
        const reply = queue.shift();
        if (!reply) throw new Error('Unexpected PayPal request in test');
        if ('throw' in reply) throw reply.throw;
        return {
          data: reply.body === undefined ? '' : JSON.stringify(reply.body),
          status: reply.status,
          statusText: '',
          headers: reply.body === undefined ? {} : { 'content-type': 'application/json' },
          config,
        };
      },
    },
  });
  return { payments: new PaymentsController(client), requests };
}

/** A haircut booking ($10.00 deposit) whose deposit PayPal is holding as AUTH-1. */
function heldBooking(
  store: BookingStore,
  status: BookingStatus = 'deposit_held',
  hold: Partial<DepositHold> = {},
): Booking {
  const booking = createBooking(
    store,
    { serviceId: 'haircut', customerName: 'Ana', startsAt: '2026-11-02T10:00:00.000Z' },
    NOW,
  );
  const held: Booking = {
    ...booking,
    status,
    hold: {
      paypalOrderId: 'ORDER-1',
      orderAttempt: 1,
      orderCreatedAt: NOW.toISOString(),
      authorizationId: 'AUTH-1',
      authorizationStatus: 'CREATED',
      expiresAt: '2026-11-30T00:00:00Z',
      heldAt: NOW.toISOString(),
      ...hold,
    },
  };
  store.save(held);
  return held;
}

const captureReply = (value: string, status = 'COMPLETED', id = 'CAP-1'): Reply => ({
  status: 201,
  body: { id, status, amount: { currency_code: 'USD', value } },
});
const paypalError = (status: number, issue: string, debugId = 'dbg-1'): Reply => ({
  status,
  body: { name: 'UNPROCESSABLE_ENTITY', message: 'nope', debug_id: debugId, details: [{ issue }] },
});
const networkDrop = (): Reply => ({
  throw: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseCents', () => {
  it('parses PayPal decimal strings without floating point', () => {
    expect(parseCents('10.00')).toBe(1000);
    expect(parseCents('4.5')).toBe(450);
    expect(parseCents('7')).toBe(700);
    expect(parseCents('0.29')).toBe(29);
    expect(parseCents('1.234')).toBeUndefined();
    expect(parseCents('-1.00')).toBeUndefined();
    expect(parseCents(undefined)).toBeUndefined();
  });
});

describe('captureDeposit', () => {
  it('captures the whole deposit for a completed appointment', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const { payments, requests } = stubPayments(captureReply('10.00'));

    const result = await captureDeposit(payments, store, booking.id, { reason: 'completed' }, NOW);

    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${API}/v2/payments/authorizations/AUTH-1/capture`);
    expect(req.headers['paypal-request-id']).toBe('slotkeeper-capture-AUTH-1-1');
    expect(req.headers.prefer).toBe('return=representation');
    expect(req.body).toEqual({
      amount: { currency_code: 'USD', value: '10.00' },
      final_capture: true,
      invoice_id: `${booking.id}-capture-1`,
      note_to_payer: 'Deposit applied to your appointment.',
    });
    expect(result.status).toBe('completed');
    expect(store.get(booking.id)!.hold!.capture).toEqual({
      captureId: 'CAP-1',
      amountCents: 1000,
      status: 'COMPLETED',
      reason: 'completed',
      capturedAt: NOW.toISOString(),
    });
  });

  it('captures a partial no-show fee with final_capture so the rest of the hold is released', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const { payments, requests } = stubPayments(captureReply('4.00'));

    const result = await captureDeposit(
      payments,
      store,
      booking.id,
      { reason: 'no_show', amountCents: 400 },
      NOW,
    );

    expect(requests[0].body).toMatchObject({
      amount: { currency_code: 'USD', value: '4.00' },
      final_capture: true,
      note_to_payer: 'No-show fee for your missed appointment.',
    });
    expect(result.status).toBe('no_show_charged');
    expect(result.hold!.capture).toMatchObject({ amountCents: 400, reason: 'no_show' });
  });

  it.each([0, -100, 1001, 2.5, Number.NaN])('rejects a no-show fee of %s cents without calling PayPal', async (cents) => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const { payments, requests } = stubPayments();
    await expect(
      captureDeposit(payments, store, booking.id, { reason: 'no_show', amountCents: cents }, NOW),
    ).rejects.toMatchObject({ code: 'invalid_amount', httpStatus: 400 });
    expect(requests).toHaveLength(0);
  });

  it('rejects a partial amount for a completed appointment', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const { payments, requests } = stubPayments();
    await expect(
      captureDeposit(payments, store, booking.id, { reason: 'completed', amountCents: 500 }, NOW),
    ).rejects.toMatchObject({ code: 'invalid_amount' });
    expect(requests).toHaveLength(0);
  });

  it.each<BookingStatus>(['deposit_pending', 'deposit_needs_review', 'cancelled', 'completed'])(
    'refuses to capture a %s booking',
    async (status) => {
      const store = createMemoryBookingStore();
      const booking = heldBooking(store, status);
      const { payments, requests } = stubPayments();
      await expect(
        captureDeposit(payments, store, booking.id, { reason: 'completed' }, NOW),
      ).rejects.toMatchObject({ code: 'invalid_state', httpStatus: 409 });
      expect(requests).toHaveLength(0);
    },
  );

  it('returns 404 for an unknown booking and 409 for one without a hold', async () => {
    const store = createMemoryBookingStore();
    const { payments } = stubPayments();
    await expect(
      captureDeposit(payments, store, 'nope', { reason: 'completed' }, NOW),
    ).rejects.toMatchObject({ code: 'booking_not_found', httpStatus: 404 });
    const unpaid = createBooking(
      store,
      { serviceId: 'haircut', customerName: 'Bo', startsAt: '2026-11-02T10:00:00.000Z' },
      NOW,
    );
    await expect(
      captureDeposit(payments, store, unpaid.id, { reason: 'completed' }, NOW),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('maps AUTHORIZATION_EXPIRED and bumps the attempt so the next try uses a fresh request id', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const { payments, requests } = stubPayments(
      paypalError(422, 'AUTHORIZATION_EXPIRED', 'dbg-exp'),
      captureReply('10.00'),
    );

    await expect(
      captureDeposit(payments, store, booking.id, { reason: 'completed' }, NOW),
    ).rejects.toMatchObject({
      code: 'authorization_expired',
      httpStatus: 409,
      paypal: { issue: 'AUTHORIZATION_EXPIRED', debugId: 'dbg-exp' },
    });
    expect(store.get(booking.id)!.status).toBe('deposit_held');
    expect(store.get(booking.id)!.hold!.pendingAction).toBeUndefined();

    await captureDeposit(payments, store, booking.id, { reason: 'completed' }, NOW);
    expect(requests.map((r) => r.headers['paypal-request-id'])).toEqual([
      'slotkeeper-capture-AUTH-1-1',
      'slotkeeper-capture-AUTH-1-2',
    ]);
    // R7: a fresh attempt also gets a fresh invoice id, so DUPLICATE_INVOICE_ID can't block the retry.
    expect(requests.map((r) => r.body.invoice_id)).toEqual([
      `${booking.id}-capture-1`,
      `${booking.id}-capture-2`,
    ]);
  });

  it('R6: an ALREADY_CAPTURED answer moves the booking to staff review', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const { payments } = stubPayments(paypalError(422, 'AUTHORIZATION_ALREADY_CAPTURED'));
    await expect(
      captureDeposit(payments, store, booking.id, { reason: 'completed' }, NOW),
    ).rejects.toMatchObject({ code: 'needs_review' });
    expect(store.get(booking.id)!.status).toBe('deposit_needs_review');
  });

  it('R4: an SDK argument error is not marked pending and is surfaced without request details', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const payments = {
      captureAuthorizedPayment: async () => {
        throw new ArgumentsValidationError({});
      },
    } as unknown as DepositPayments;
    await expect(
      captureDeposit(payments, store, booking.id, { reason: 'completed' }, NOW),
    ).rejects.toThrow('Could not capture the deposit: Error: One or more arguments failed validation.');
    expect(store.get(booking.id)!.hold!.pendingAction).toBeUndefined();
  });

  it('R4: an unreadable failure is logged with its name and first line', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const payments = {
      captureAuthorizedPayment: async () => {
        throw new TypeError('boom\nsecond line with Authorization: Basic abc');
      },
    } as unknown as DepositPayments;
    await expect(
      captureDeposit(payments, store, booking.id, { reason: 'completed' }, NOW),
    ).rejects.toMatchObject({ code: 'paypal_error' });
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain('TypeError: boom');
    expect(logged).not.toContain('Basic abc');
    expect(store.get(booking.id)!.hold!.pendingAction?.kind).toBe('capture');
  });

  it.each([
    ['AUTHORIZATION_VOIDED', 'invalid_state', 409],
    ['AUTHORIZATION_ALREADY_CAPTURED', 'needs_review', 409],
    ['INSTRUMENT_DECLINED', 'declined', 402],
    ['SOMETHING_NEW', 'paypal_error', 422],
  ])('maps PayPal issue %s to %s', async (issue, code, httpStatus) => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const { payments } = stubPayments(paypalError(422, issue));
    await expect(
      captureDeposit(payments, store, booking.id, { reason: 'completed' }, NOW),
    ).rejects.toMatchObject({ code, httpStatus });
  });

  it('after a 5xx, keeps the capture pending: other actions and other amounts are refused, a replay reuses the id', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const { payments, requests } = stubPayments(
      { status: 500, body: { name: 'INTERNAL_SERVER_ERROR', debug_id: 'dbg-500' } },
      captureReply('4.00'),
    );

    await expect(
      captureDeposit(payments, store, booking.id, { reason: 'no_show', amountCents: 400 }, NOW),
    ).rejects.toMatchObject({ code: 'paypal_error', httpStatus: 502 });
    expect(store.get(booking.id)!.hold!.pendingAction).toEqual({
      kind: 'capture',
      requestId: 'slotkeeper-capture-AUTH-1-1',
      amountCents: 400,
      reason: 'no_show',
      since: NOW.toISOString(),
    });

    await expect(voidDeposit(payments, store, booking.id, NOW)).rejects.toMatchObject({
      code: 'pending_action',
      httpStatus: 409,
    });
    await expect(
      captureDeposit(payments, store, booking.id, { reason: 'no_show', amountCents: 500 }, NOW),
    ).rejects.toMatchObject({ code: 'pending_action' });
    // N1: a replay with a different reason is refused too.
    await expect(
      captureDeposit(payments, store, booking.id, { reason: 'completed' }, NOW),
    ).rejects.toMatchObject({ code: 'pending_action' });
    expect(requests).toHaveLength(1);

    // Replaying without an amount reuses the pending amount and the same PayPal-Request-Id.
    const result = await captureDeposit(payments, store, booking.id, { reason: 'no_show' }, LATER);
    expect(requests).toHaveLength(2);
    expect(requests[1].headers['paypal-request-id']).toBe('slotkeeper-capture-AUTH-1-1');
    expect(requests[1].body.amount).toEqual({ currency_code: 'USD', value: '4.00' });
    expect(result.status).toBe('no_show_charged');
    expect(result.hold!.pendingAction).toBeUndefined();
  });

  it('after a network drop, marks the capture pending and maps to network_error', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const { payments, requests } = stubPayments(networkDrop(), captureReply('10.00'));

    await expect(
      captureDeposit(payments, store, booking.id, { reason: 'completed' }, NOW),
    ).rejects.toMatchObject({ code: 'network_error', httpStatus: 502 });
    expect(store.get(booking.id)!.hold!.pendingAction?.kind).toBe('capture');

    await captureDeposit(payments, store, booking.id, { reason: 'completed' }, NOW);
    expect(requests[0].headers['paypal-request-id']).toBe(requests[1].headers['paypal-request-id']);
  });

  it('treats a 2xx without a capture id as outcome-unknown', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const { payments } = stubPayments({ status: 201, body: { status: 'COMPLETED' } });
    await expect(
      captureDeposit(payments, store, booking.id, { reason: 'completed' }, NOW),
    ).rejects.toMatchObject({ code: 'paypal_error', httpStatus: 502 });
    expect(store.get(booking.id)!.hold!.pendingAction?.kind).toBe('capture');
    expect(store.get(booking.id)!.hold!.capture).toBeUndefined();
  });

  it('a DECLINED capture is a definite failure: declined, nothing recorded, attempt bumped', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const { payments } = stubPayments(captureReply('10.00', 'DECLINED'));
    await expect(
      captureDeposit(payments, store, booking.id, { reason: 'completed' }, NOW),
    ).rejects.toMatchObject({ code: 'declined', httpStatus: 402 });
    const hold = store.get(booking.id)!.hold!;
    expect(hold.capture).toBeUndefined();
    expect(hold.pendingAction).toBeUndefined();
    expect(hold.actionAttempts).toEqual({ capture: 2 });
    expect(store.get(booking.id)!.status).toBe('deposit_held');
  });

  it('a capture for a different amount than requested goes to staff review but keeps the record', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const { payments } = stubPayments(captureReply('9.00'));
    await expect(
      captureDeposit(payments, store, booking.id, { reason: 'completed' }, NOW),
    ).rejects.toMatchObject({ code: 'amount_mismatch' });
    const saved = store.get(booking.id)!;
    expect(saved.status).toBe('deposit_needs_review');
    expect(saved.hold!.capture?.captureId).toBe('CAP-1');
  });

  it('never logs credentials or tokens', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const { payments } = stubPayments(
      { status: 500, body: { name: 'INTERNAL_SERVER_ERROR', debug_id: 'dbg-500' } },
      networkDrop(),
    );
    await captureDeposit(payments, store, booking.id, { reason: 'completed' }, NOW).catch(() => {});
    await captureDeposit(payments, store, booking.id, { reason: 'completed' }, NOW).catch(() => {});
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain('seeded-token');
    expect(logged).not.toContain('dummy-secret');
    expect(logged).not.toMatch(/authorization/i);
  });
});

describe('voidDeposit', () => {
  it('voids the hold (204, no body) and cancels the booking', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const { payments, requests } = stubPayments({ status: 204 });

    const result = await voidDeposit(payments, store, booking.id, NOW);

    expect(requests[0].url).toBe(`${API}/v2/payments/authorizations/AUTH-1/void`);
    expect(requests[0].headers['paypal-request-id']).toBe('slotkeeper-void-AUTH-1-1');
    expect(result.status).toBe('cancelled');
    expect(result.hold).toMatchObject({ authorizationStatus: 'VOIDED', voidedAt: NOW.toISOString() });
  });

  it('accepts a VOIDED representation and works from staff review', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store, 'deposit_needs_review');
    const { payments } = stubPayments({ status: 200, body: { id: 'AUTH-1', status: 'VOIDED' } });
    expect((await voidDeposit(payments, store, booking.id, NOW)).status).toBe('cancelled');
  });

  it('refuses to void a captured deposit', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store, 'completed', {
      capture: {
        captureId: 'CAP-1',
        amountCents: 1000,
        status: 'COMPLETED',
        reason: 'completed',
        capturedAt: NOW.toISOString(),
      },
    });
    const { payments, requests } = stubPayments();
    await expect(voidDeposit(payments, store, booking.id, NOW)).rejects.toMatchObject({
      code: 'invalid_state',
      message: expect.stringContaining('refund'),
    });
    expect(requests).toHaveLength(0);
  });

  it('a void answered with another status goes to staff review', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const { payments } = stubPayments({ status: 200, body: { id: 'AUTH-1', status: 'CAPTURED' } });
    await expect(voidDeposit(payments, store, booking.id, NOW)).rejects.toMatchObject({
      code: 'needs_review',
    });
    expect(store.get(booking.id)!.status).toBe('deposit_needs_review');
  });
});

describe('reauthorizeDeposit', () => {
  it('replaces the authorization id and keeps the old one', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const { payments, requests } = stubPayments({
      status: 201,
      body: {
        id: 'AUTH-2',
        status: 'CREATED',
        amount: { currency_code: 'USD', value: '10.00' },
        expiration_time: '2026-12-03T00:00:00Z',
      },
    });

    const result = await reauthorizeDeposit(payments, store, booking.id, LATER);

    expect(requests[0].url).toBe(`${API}/v2/payments/authorizations/AUTH-1/reauthorize`);
    expect(requests[0].headers['paypal-request-id']).toBe('slotkeeper-reauthorize-AUTH-1-1');
    expect(requests[0].body).toEqual({ amount: { currency_code: 'USD', value: '10.00' } });
    expect(result.status).toBe('deposit_held');
    expect(result.hold).toMatchObject({
      authorizationId: 'AUTH-2',
      authorizationStatus: 'CREATED',
      expiresAt: '2026-12-03T00:00:00Z',
      previousAuthorizationIds: ['AUTH-1'],
      heldAt: LATER.toISOString(),
    });

    // Later money calls act on the new authorization.
    const capture = stubPayments(captureReply('10.00'));
    await captureDeposit(capture.payments, store, booking.id, { reason: 'completed' }, LATER);
    expect(capture.requests[0].url).toBe(`${API}/v2/payments/authorizations/AUTH-2/capture`);
  });

  it('a reauthorization that is not CREATED or PENDING goes to staff review, keeping the new id (R6)', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const { payments } = stubPayments({ status: 201, body: { id: 'AUTH-2', status: 'DENIED' } });
    await expect(reauthorizeDeposit(payments, store, booking.id, LATER)).rejects.toMatchObject({
      code: 'needs_review',
    });
    const saved = store.get(booking.id)!;
    expect(saved.status).toBe('deposit_needs_review');
    expect(saved.hold).toMatchObject({
      authorizationId: 'AUTH-2',
      authorizationStatus: 'DENIED',
      previousAuthorizationIds: ['AUTH-1'],
    });
  });

  it('maps a too-early reauthorization (honor period) to a 422 paypal_error', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const { payments } = stubPayments(paypalError(422, 'REAUTHORIZATION_TOO_SOON'));
    await expect(reauthorizeDeposit(payments, store, booking.id, NOW)).rejects.toMatchObject({
      code: 'paypal_error',
      httpStatus: 422,
      paypal: { issue: 'REAUTHORIZATION_TOO_SOON' },
    });
  });
});

describe('refundDeposit', () => {
  const capturedNoShow = (store: BookingStore) =>
    heldBooking(store, 'no_show_charged', {
      capture: {
        captureId: 'CAP-1',
        amountCents: 400,
        status: 'COMPLETED',
        reason: 'no_show',
        capturedAt: NOW.toISOString(),
      },
    });
  const refundReply = (id: string, value: string, status = 'COMPLETED'): Reply => ({
    status: 201,
    body: { id, status, amount: { currency_code: 'USD', value } },
  });

  it('refunds part, then the rest, moving partially_refunded -> refunded', async () => {
    const store = createMemoryBookingStore();
    const booking = capturedNoShow(store);
    const { payments, requests } = stubPayments(refundReply('REF-1', '1.50'), refundReply('REF-2', '2.50'));

    const partial = await refundDeposit(payments, store, booking.id, { amountCents: 150 }, NOW);
    expect(partial.status).toBe('partially_refunded');
    expect(requests[0].url).toBe(`${API}/v2/payments/captures/CAP-1/refund`);
    expect(requests[0].headers['paypal-request-id']).toBe('slotkeeper-refund-CAP-1-1-1');
    expect(requests[0].body).toMatchObject({
      amount: { currency_code: 'USD', value: '1.50' },
      invoice_id: `${booking.id}-refund-1-1`,
    });

    const full = await refundDeposit(payments, store, booking.id, {}, LATER);
    expect(requests[1].headers['paypal-request-id']).toBe('slotkeeper-refund-CAP-1-2-1');
    expect(requests[1].body.amount).toEqual({ currency_code: 'USD', value: '2.50' });
    expect(full.status).toBe('refunded');
    expect(full.hold!.refunds!.map((r) => [r.refundId, r.amountCents])).toEqual([
      ['REF-1', 150],
      ['REF-2', 250],
    ]);
  });

  it('refuses more than is still refundable, and refunds on a booking with nothing captured', async () => {
    const store = createMemoryBookingStore();
    const booking = capturedNoShow(store);
    const { payments, requests } = stubPayments();
    await expect(
      refundDeposit(payments, store, booking.id, { amountCents: 401 }, NOW),
    ).rejects.toMatchObject({ code: 'invalid_amount' });

    const held = heldBooking(store);
    await expect(refundDeposit(payments, store, held.id, {}, NOW)).rejects.toMatchObject({
      code: 'invalid_state',
    });
    expect(requests).toHaveLength(0);
  });

  it('a FAILED refund is not recorded and the next try uses a fresh request id', async () => {
    const store = createMemoryBookingStore();
    const booking = capturedNoShow(store);
    const { payments, requests } = stubPayments(
      refundReply('REF-1', '4.00', 'FAILED'),
      refundReply('REF-2', '4.00'),
    );
    await expect(refundDeposit(payments, store, booking.id, {}, NOW)).rejects.toMatchObject({
      code: 'declined',
    });
    expect(store.get(booking.id)!.hold!.refunds).toBeUndefined();
    expect(store.get(booking.id)!.status).toBe('no_show_charged');

    const done = await refundDeposit(payments, store, booking.id, {}, NOW);
    expect(requests[1].headers['paypal-request-id']).toBe('slotkeeper-refund-CAP-1-1-2');
    expect(done.status).toBe('refunded');
  });

  it('a refund with an unknown outcome is replayed with the same id and amount', async () => {
    const store = createMemoryBookingStore();
    const booking = capturedNoShow(store);
    const { payments, requests } = stubPayments(networkDrop(), refundReply('REF-1', '1.00'));
    await expect(
      refundDeposit(payments, store, booking.id, { amountCents: 100 }, NOW),
    ).rejects.toMatchObject({ code: 'network_error' });

    // R5: a replay asking for a different amount is refused, not silently swapped.
    await expect(
      refundDeposit(payments, store, booking.id, { amountCents: 300 }, NOW),
    ).rejects.toMatchObject({ code: 'pending_action' });
    expect(requests).toHaveLength(1);

    const result = await refundDeposit(payments, store, booking.id, {}, NOW);
    expect(requests[1].headers['paypal-request-id']).toBe(requests[0].headers['paypal-request-id']);
    expect(requests[1].body.amount.value).toBe('1.00');
    expect(result.status).toBe('partially_refunded');
  });

  it('R3: a refund for a different amount than requested records PayPal\'s amount and goes to review', async () => {
    const store = createMemoryBookingStore();
    const booking = capturedNoShow(store);
    const { payments } = stubPayments(refundReply('REF-1', '3.00'));
    await expect(
      refundDeposit(payments, store, booking.id, { amountCents: 100 }, NOW),
    ).rejects.toMatchObject({ code: 'amount_mismatch' });
    const saved = store.get(booking.id)!;
    expect(saved.status).toBe('deposit_needs_review');
    expect(saved.hold!.refunds).toMatchObject([{ refundId: 'REF-1', amountCents: 300 }]);
  });
});

describe('concurrent money actions on one booking (R1, R2)', () => {
  it('a void started while a capture is in flight is refused and the capture record survives', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const { payments, requests } = stubPayments(captureReply('10.00'));

    const [capture, voided] = await Promise.allSettled([
      captureDeposit(payments, store, booking.id, { reason: 'completed' }, NOW),
      voidDeposit(payments, store, booking.id, NOW),
    ]);

    expect(capture.status).toBe('fulfilled');
    expect(voided).toMatchObject({ status: 'rejected', reason: { code: 'pending_action', httpStatus: 409 } });
    expect(requests).toHaveLength(1);
    const saved = store.get(booking.id)!;
    expect(saved.status).toBe('completed');
    expect(saved.hold!.capture?.captureId).toBe('CAP-1');
  });

  it('two refunds at once: only one reaches PayPal and the recorded amount matches it', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store, 'no_show_charged', {
      capture: {
        captureId: 'CAP-1',
        amountCents: 1000,
        status: 'COMPLETED',
        reason: 'no_show',
        capturedAt: NOW.toISOString(),
      },
    });
    const { payments, requests } = stubPayments({
      status: 201,
      body: { id: 'REF-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '3.00' } },
    });

    const [first, second] = await Promise.allSettled([
      refundDeposit(payments, store, booking.id, { amountCents: 300 }, NOW),
      refundDeposit(payments, store, booking.id, { amountCents: 500 }, NOW),
    ]);

    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({ status: 'rejected', reason: { code: 'pending_action' } });
    expect(requests).toHaveLength(1);
    expect(store.get(booking.id)!.hold!.refunds).toMatchObject([{ refundId: 'REF-1', amountCents: 300 }]);
  });

  it('the lock is released after a failure, so the next action can run', async () => {
    const store = createMemoryBookingStore();
    const booking = heldBooking(store);
    const { payments } = stubPayments(paypalError(422, 'SOMETHING_NEW'), { status: 204 });
    await expect(
      captureDeposit(payments, store, booking.id, { reason: 'completed' }, NOW),
    ).rejects.toMatchObject({ code: 'paypal_error' });
    expect((await voidDeposit(payments, store, booking.id, NOW)).status).toBe('cancelled');
  });
});
