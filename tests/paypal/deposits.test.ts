import { Client, Environment, OrdersController } from '@paypal/paypal-server-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBooking } from '@/lib/booking/bookings';
import { createMemoryBookingStore, type Booking, type BookingStore } from '@/lib/booking/store';
import { authorizeDeposit, createDepositOrder, DepositError } from '@/lib/paypal/deposits';

// Fixed clock: tests never depend on the real date.
const NOW = new Date('2026-11-01T00:00:00.000Z');
const URLS = { returnUrl: 'https://app.test/return', cancelUrl: 'https://app.test/cancel' };

type Reply = { status: number; body: unknown } | { throw: Error };

/**
 * A real OrdersController over a stub axios adapter (the SDK's `unstable_httpClientOptions` seam),
 * with a seeded OAuth token so no token request goes through the adapter.
 */
function stubOrders(...replies: Reply[]) {
  const requests: Array<{ method: string; url: string; headers: Record<string, string>; body: any }> = [];
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
          data: JSON.stringify(reply.body),
          status: reply.status,
          statusText: '',
          headers: { 'content-type': 'application/json' },
          config,
        };
      },
    },
  });
  return { orders: new OrdersController(client), requests };
}

function newBooking(store: BookingStore): Booking {
  return createBooking(
    store,
    { serviceId: 'haircut', customerName: 'Ana', startsAt: '2026-11-02T10:00:00.000Z' },
    NOW,
  );
}

function authorizeReply(bookingId: string, authorization: Record<string, unknown>) {
  return {
    status: 201,
    body: {
      id: 'ORDER-1',
      status: 'COMPLETED',
      intent: 'AUTHORIZE',
      purchase_units: [{ reference_id: bookingId, payments: { authorizations: [authorization] } }],
    },
  };
}

const HELD_AUTH = {
  id: 'AUTH-1',
  status: 'CREATED',
  amount: { currency_code: 'USD', value: '10.00' },
  expiration_time: '2026-11-30T00:00:00Z',
};

async function bookingWithOrder(store: BookingStore) {
  const booking = newBooking(store);
  const { orders } = stubOrders({ status: 201, body: { id: 'ORDER-1', status: 'PAYER_ACTION_REQUIRED' } });
  await createDepositOrder(orders, store, booking.id, URLS, NOW);
  return booking;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('createDepositOrder', () => {
  it('sends an AUTHORIZE order for the catalog deposit and stores the order id', async () => {
    const store = createMemoryBookingStore();
    const booking = newBooking(store);
    const { orders, requests } = stubOrders({
      status: 201,
      body: { id: 'ORDER-1', status: 'PAYER_ACTION_REQUIRED' },
    });

    const result = await createDepositOrder(orders, store, booking.id, URLS, NOW);

    expect(result).toEqual({ orderId: 'ORDER-1' });
    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders');
    expect(req.headers['paypal-request-id']).toBe(`slotkeeper-deposit-order-${booking.id}-1`);
    expect(req.headers.authorization).toBe('Bearer seeded-token');
    expect(req.body).toMatchObject({
      intent: 'AUTHORIZE',
      purchase_units: [
        {
          reference_id: booking.id,
          custom_id: booking.id,
          amount: { currency_code: 'USD', value: '10.00' },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            return_url: URLS.returnUrl,
            cancel_url: URLS.cancelUrl,
          },
        },
      },
    });
    expect(store.get(booking.id)!.hold).toEqual({
      paypalOrderId: 'ORDER-1',
      orderAttempt: 1,
      orderCreatedAt: NOW.toISOString(),
    });
  });

  it('reuses a recent order instead of creating a second one', async () => {
    const store = createMemoryBookingStore();
    const booking = await bookingWithOrder(store);
    const { orders, requests } = stubOrders();

    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    await expect(createDepositOrder(orders, store, booking.id, URLS, later)).resolves.toEqual({
      orderId: 'ORDER-1',
    });
    expect(requests).toHaveLength(0);
  });

  it('replaces an order older than two hours with a new attempt id', async () => {
    const store = createMemoryBookingStore();
    const booking = await bookingWithOrder(store);
    const { orders, requests } = stubOrders({ status: 201, body: { id: 'ORDER-2' } });

    const later = new Date(NOW.getTime() + 2 * 60 * 60 * 1000 + 1);
    await expect(createDepositOrder(orders, store, booking.id, URLS, later)).resolves.toEqual({
      orderId: 'ORDER-2',
    });
    expect(requests[0].headers['paypal-request-id']).toBe(
      `slotkeeper-deposit-order-${booking.id}-2`,
    );
    expect(store.get(booking.id)!.hold).toMatchObject({ paypalOrderId: 'ORDER-2', orderAttempt: 2 });
  });

  it('rejects an unknown booking without calling PayPal', async () => {
    const { orders, requests } = stubOrders();
    await expect(
      createDepositOrder(orders, createMemoryBookingStore(), 'nope', URLS, NOW),
    ).rejects.toMatchObject({ code: 'booking_not_found', httpStatus: 404 });
    expect(requests).toHaveLength(0);
  });

  it('maps a PayPal 500 to paypal_error and stores nothing', async () => {
    const store = createMemoryBookingStore();
    const booking = newBooking(store);
    const { orders } = stubOrders({
      status: 500,
      body: { name: 'INTERNAL_SERVER_ERROR', message: 'boom', debug_id: 'dbg-500' },
    });
    await expect(createDepositOrder(orders, store, booking.id, URLS, NOW)).rejects.toMatchObject({
      code: 'paypal_error',
      httpStatus: 502,
      paypal: { status: 500, debugId: 'dbg-500' },
    });
    expect(store.get(booking.id)!.hold).toBeUndefined();
  });

  it('maps a transport failure to network_error', async () => {
    const store = createMemoryBookingStore();
    const booking = newBooking(store);
    const { orders } = stubOrders({
      throw: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    });
    await expect(createDepositOrder(orders, store, booking.id, URLS, NOW)).rejects.toMatchObject({
      code: 'network_error',
      httpStatus: 502,
    });
  });
});

describe('transport failures through the real SDK', () => {
  it('maps a TLS failure to network_error without logging the bearer token', async () => {
    const store = createMemoryBookingStore();
    const booking = newBooking(store);
    const tls = Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      isAxiosError: true,
      config: { headers: { Authorization: 'Bearer seeded-token' } },
    });
    const { orders } = stubOrders({ throw: tls });

    await expect(createDepositOrder(orders, store, booking.id, URLS, NOW)).rejects.toMatchObject({
      code: 'network_error',
      httpStatus: 502,
    });
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain('NODE_OPTIONS=--use-system-ca');
    expect(logged).not.toContain('seeded-token');
  });
});

describe('R9/R10/S2 hardening', () => {
  const notApproved: Reply = {
    status: 422,
    body: { name: 'UNPROCESSABLE_ENTITY', debug_id: 'dbg', details: [{ issue: 'ORDER_NOT_APPROVED' }] },
  };

  it('N1: an unknown service is a 409 local error and never reaches PayPal as a 500', async () => {
    const store = createMemoryBookingStore();
    const booking = newBooking(store);
    store.save({ ...booking, serviceId: 'retired-service' });
    const { orders, requests } = stubOrders();
    await expect(createDepositOrder(orders, store, booking.id, URLS, NOW)).rejects.toMatchObject({
      code: 'invalid_state',
      httpStatus: 409,
    });
    expect(requests).toHaveLength(0);
  });

  it('R10: an unreadable 2xx authorize response is outcome-unknown and replayed with the same id', async () => {
    const store = createMemoryBookingStore();
    const booking = await bookingWithOrder(store);
    const garbled = stubOrders({ status: 201, body: 'not an order' });
    await expect(
      authorizeDeposit(garbled.orders, store, booking.id, 'ORDER-1', NOW),
    ).rejects.toMatchObject({ code: 'paypal_error', httpStatus: 502 });
    expect(store.get(booking.id)!.hold).toMatchObject({ authorizeOutcomeUnknown: true });

    const replay = stubOrders(notApproved);
    await expect(
      createDepositOrder(replay.orders, store, booking.id, URLS, new Date(NOW.getTime() + 60_000)),
    ).resolves.toEqual({ orderId: 'ORDER-1' });
    expect(replay.requests[0].url).toContain('/v2/checkout/orders/ORDER-1/authorize');
    expect(replay.requests[0].headers['paypal-request-id']).toBe(
      'slotkeeper-deposit-authorize-ORDER-1-1',
    );
  });

  it('S2: ORDER_ALREADY_AUTHORIZED stops the flow for staff review instead of retrying', async () => {
    const store = createMemoryBookingStore();
    const booking = await bookingWithOrder(store);
    const { orders } = stubOrders({
      status: 422,
      body: { name: 'UNPROCESSABLE_ENTITY', debug_id: 'dbg-dup', details: [{ issue: 'ORDER_ALREADY_AUTHORIZED' }] },
    });
    await expect(authorizeDeposit(orders, store, booking.id, 'ORDER-1', NOW)).rejects.toMatchObject({
      code: 'needs_review',
      httpStatus: 409,
      paypal: { debugId: 'dbg-dup' },
    });
    expect(store.get(booking.id)!.status).toBe('deposit_needs_review');

    // Checkout must not start a new order for a booking under review, and PayPal is not called.
    const again = stubOrders();
    await expect(createDepositOrder(again.orders, store, booking.id, URLS, NOW)).rejects.toMatchObject({
      code: 'invalid_state',
      httpStatus: 409,
      message: 'This booking is under staff review.',
    });
    expect(again.requests).toHaveLength(0);
  });
});

describe('authorizeDeposit', () => {
  it('authorizes the approved order and stores the authorization id', async () => {
    const store = createMemoryBookingStore();
    const booking = await bookingWithOrder(store);
    const { orders, requests } = stubOrders(authorizeReply(booking.id, HELD_AUTH));
    const heldAt = new Date(NOW.getTime() + 5 * 60 * 1000);

    const updated = await authorizeDeposit(orders, store, booking.id, 'ORDER-1', heldAt);

    expect(requests[0].method).toBe('POST');
    expect(requests[0].url).toBe(
      'https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-1/authorize',
    );
    expect(requests[0].headers['paypal-request-id']).toBe('slotkeeper-deposit-authorize-ORDER-1-1');
    expect(requests[0].headers.prefer).toBe('return=representation');
    expect(updated.status).toBe('deposit_held');
    expect(updated.hold).toEqual({
      paypalOrderId: 'ORDER-1',
      orderAttempt: 1,
      orderCreatedAt: NOW.toISOString(),
      authorizeOutcomeUnknown: false,
      authorizationId: 'AUTH-1',
      authorizationStatus: 'CREATED',
      expiresAt: '2026-11-30T00:00:00Z',
      heldAt: heldAt.toISOString(),
    });
    expect(store.get(booking.id)).toEqual(updated);
  });

  it('records a PENDING authorization as deposit_pending', async () => {
    const store = createMemoryBookingStore();
    const booking = await bookingWithOrder(store);
    const { orders } = stubOrders(authorizeReply(booking.id, { ...HELD_AUTH, status: 'PENDING' }));
    const updated = await authorizeDeposit(orders, store, booking.id, 'ORDER-1', NOW);
    expect(updated.status).toBe('deposit_pending');
  });

  it('treats a DENIED authorization as declined and keeps the booking unpaid', async () => {
    const store = createMemoryBookingStore();
    const booking = await bookingWithOrder(store);
    const { orders } = stubOrders(authorizeReply(booking.id, { ...HELD_AUTH, status: 'DENIED' }));
    await expect(authorizeDeposit(orders, store, booking.id, 'ORDER-1', NOW)).rejects.toMatchObject({
      code: 'declined',
      httpStatus: 402,
    });
    expect(store.get(booking.id)!.status).toBe('awaiting_deposit');
  });

  it('refuses an order id that does not belong to the booking, without calling PayPal', async () => {
    const store = createMemoryBookingStore();
    const booking = await bookingWithOrder(store);
    const { orders, requests } = stubOrders();
    await expect(
      authorizeDeposit(orders, store, booking.id, 'SOMEONE-ELSES-ORDER', NOW),
    ).rejects.toMatchObject({ code: 'order_mismatch', httpStatus: 409 });
    expect(requests).toHaveLength(0);
  });

  it('is idempotent: a second authorize returns the stored hold without calling PayPal', async () => {
    const store = createMemoryBookingStore();
    const booking = await bookingWithOrder(store);
    const first = await authorizeDeposit(
      stubOrders(authorizeReply(booking.id, HELD_AUTH)).orders,
      store,
      booking.id,
      'ORDER-1',
      NOW,
    );
    const { orders, requests } = stubOrders();
    await expect(authorizeDeposit(orders, store, booking.id, 'ORDER-1', NOW)).resolves.toEqual(first);
    expect(requests).toHaveLength(0);
  });

  it('maps ORDER_NOT_APPROVED to not_approved with the PayPal debug id', async () => {
    const store = createMemoryBookingStore();
    const booking = await bookingWithOrder(store);
    const { orders } = stubOrders({
      status: 422,
      body: {
        name: 'UNPROCESSABLE_ENTITY',
        message: 'The requested action could not be performed.',
        debug_id: 'dbg-422',
        details: [{ issue: 'ORDER_NOT_APPROVED', description: 'Payer has not yet approved.' }],
      },
    });
    const err = await authorizeDeposit(orders, store, booking.id, 'ORDER-1', NOW).catch((e) => e);
    expect(err).toBeInstanceOf(DepositError);
    expect(err).toMatchObject({
      code: 'not_approved',
      httpStatus: 409,
      paypal: { status: 422, issue: 'ORDER_NOT_APPROVED', debugId: 'dbg-422' },
    });
    expect(store.get(booking.id)!.status).toBe('awaiting_deposit');
  });

  it('maps INSTRUMENT_DECLINED to declined', async () => {
    const store = createMemoryBookingStore();
    const booking = await bookingWithOrder(store);
    const { orders } = stubOrders({
      status: 422,
      body: {
        name: 'UNPROCESSABLE_ENTITY',
        debug_id: 'dbg-declined',
        details: [{ issue: 'INSTRUMENT_DECLINED' }],
      },
    });
    await expect(authorizeDeposit(orders, store, booking.id, 'ORDER-1', NOW)).rejects.toMatchObject({
      code: 'declined',
      httpStatus: 402,
    });
  });

  it('keeps a mismatched authorization on record as needs-review instead of losing the hold', async () => {
    const store = createMemoryBookingStore();
    const booking = await bookingWithOrder(store);
    const { orders } = stubOrders(
      authorizeReply(booking.id, { ...HELD_AUTH, amount: { currency_code: 'USD', value: '1.00' } }),
    );
    await expect(authorizeDeposit(orders, store, booking.id, 'ORDER-1', NOW)).rejects.toMatchObject({
      code: 'amount_mismatch',
    });
    const stored = store.get(booking.id)!;
    expect(stored.status).toBe('deposit_needs_review');
    expect(stored.hold).toMatchObject({ authorizationId: 'AUTH-1', authorizationStatus: 'CREATED' });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('needs review'),
      expect.objectContaining({ authorizationId: 'AUTH-1', orderId: 'ORDER-1' }),
    );
  });

  it('treats an authorization without an amount as needing review', async () => {
    const store = createMemoryBookingStore();
    const booking = await bookingWithOrder(store);
    const { amount: _omit, ...noAmount } = HELD_AUTH;
    const { orders } = stubOrders(authorizeReply(booking.id, noAmount));
    await expect(authorizeDeposit(orders, store, booking.id, 'ORDER-1', NOW)).rejects.toMatchObject({
      code: 'amount_mismatch',
    });
    expect(store.get(booking.id)!.status).toBe('deposit_needs_review');
  });

  it('fails clearly when PayPal returns no authorization', async () => {
    const store = createMemoryBookingStore();
    const booking = await bookingWithOrder(store);
    const { orders } = stubOrders({ status: 201, body: { id: 'ORDER-1', purchase_units: [{}] } });
    await expect(authorizeDeposit(orders, store, booking.id, 'ORDER-1', NOW)).rejects.toMatchObject({
      code: 'paypal_error',
      httpStatus: 502,
    });
  });
});

describe('failure recovery', () => {
  const networkDrop = (): Reply => ({
    throw: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
  });
  const notApproved: Reply = {
    status: 422,
    body: { name: 'UNPROCESSABLE_ENTITY', debug_id: 'dbg', details: [{ issue: 'ORDER_NOT_APPROVED' }] },
  };
  const ONE_MINUTE_LATER = new Date(NOW.getTime() + 60 * 1000);

  it('R1: after a DENIED authorization the next checkout gets a new order immediately', async () => {
    const store = createMemoryBookingStore();
    const booking = await bookingWithOrder(store);
    await authorizeDeposit(
      stubOrders(authorizeReply(booking.id, { ...HELD_AUTH, status: 'DENIED' })).orders,
      store,
      booking.id,
      'ORDER-1',
      NOW,
    ).catch(() => undefined);

    // The spent order can't be authorized again, and nothing is sent to PayPal for it.
    const spent = stubOrders();
    await expect(
      authorizeDeposit(spent.orders, store, booking.id, 'ORDER-1', NOW),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    expect(spent.requests).toHaveLength(0);

    // Well inside the 2-hour reuse window, checkout still starts a fresh order (attempt 2).
    const fresh = stubOrders({ status: 201, body: { id: 'ORDER-2' } });
    await expect(
      createDepositOrder(fresh.orders, store, booking.id, URLS, ONE_MINUTE_LATER),
    ).resolves.toEqual({ orderId: 'ORDER-2' });
    expect(fresh.requests[0].headers['paypal-request-id']).toBe(
      `slotkeeper-deposit-order-${booking.id}-2`,
    );
  });

  it('R1: INSTRUMENT_DECLINED also retires the order', async () => {
    const store = createMemoryBookingStore();
    const booking = await bookingWithOrder(store);
    await authorizeDeposit(
      stubOrders({
        status: 422,
        body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] },
      }).orders,
      store,
      booking.id,
      'ORDER-1',
      NOW,
    ).catch(() => undefined);

    const fresh = stubOrders({ status: 201, body: { id: 'ORDER-2' } });
    await expect(
      createDepositOrder(fresh.orders, store, booking.id, URLS, ONE_MINUTE_LATER),
    ).resolves.toEqual({ orderId: 'ORDER-2' });
  });

  it('R1: a retry after ORDER_NOT_APPROVED sends a new request id, not the stored failure', async () => {
    const store = createMemoryBookingStore();
    const booking = await bookingWithOrder(store);
    const first = stubOrders(notApproved);
    await authorizeDeposit(first.orders, store, booking.id, 'ORDER-1', NOW).catch(() => undefined);
    expect(first.requests[0].headers['paypal-request-id']).toBe(
      'slotkeeper-deposit-authorize-ORDER-1-1',
    );

    // The order itself is still usable (the buyer just hadn't approved yet).
    const reuse = stubOrders();
    await expect(
      createDepositOrder(reuse.orders, store, booking.id, URLS, ONE_MINUTE_LATER),
    ).resolves.toEqual({ orderId: 'ORDER-1' });
    expect(reuse.requests).toHaveLength(0);

    const second = stubOrders(authorizeReply(booking.id, HELD_AUTH));
    const held = await authorizeDeposit(second.orders, store, booking.id, 'ORDER-1', NOW);
    expect(second.requests[0].headers['paypal-request-id']).toBe(
      'slotkeeper-deposit-authorize-ORDER-1-2',
    );
    expect(held.status).toBe('deposit_held');
  });

  it('R3: a lost authorize response is replayed with the same request id before any new order', async () => {
    const store = createMemoryBookingStore();
    const booking = await bookingWithOrder(store);
    await expect(
      authorizeDeposit(stubOrders(networkDrop()).orders, store, booking.id, 'ORDER-1', NOW),
    ).rejects.toMatchObject({ code: 'network_error' });
    expect(store.get(booking.id)!.hold!.authorizeOutcomeUnknown).toBe(true);

    // Customer reloads and checks out again: PayPal had in fact authorized. The replay (same id)
    // returns the stored success, the hold is recorded, and no second order is created.
    const replay = stubOrders(authorizeReply(booking.id, HELD_AUTH));
    await expect(
      createDepositOrder(replay.orders, store, booking.id, URLS, ONE_MINUTE_LATER),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    expect(replay.requests).toHaveLength(1);
    expect(replay.requests[0].url).toContain('/v2/checkout/orders/ORDER-1/authorize');
    expect(replay.requests[0].headers['paypal-request-id']).toBe(
      'slotkeeper-deposit-authorize-ORDER-1-1',
    );
    expect(store.get(booking.id)).toMatchObject({
      status: 'deposit_held',
      hold: { authorizationId: 'AUTH-1', authorizeOutcomeUnknown: false },
    });
  });

  it('R3: if the replay shows the authorize never happened, the same order is handed out again', async () => {
    const store = createMemoryBookingStore();
    const booking = await bookingWithOrder(store);
    await authorizeDeposit(stubOrders(networkDrop()).orders, store, booking.id, 'ORDER-1', NOW).catch(
      () => undefined,
    );

    const replay = stubOrders(notApproved);
    await expect(
      createDepositOrder(replay.orders, store, booking.id, URLS, ONE_MINUTE_LATER),
    ).resolves.toEqual({ orderId: 'ORDER-1' });
    expect(store.get(booking.id)!.hold).toMatchObject({
      authorizeOutcomeUnknown: false,
      authorizeAttempt: 2,
    });
  });

  it('R3: a PayPal 5xx on authorize is treated as unknown and replayed with the same id', async () => {
    const store = createMemoryBookingStore();
    const booking = await bookingWithOrder(store);
    await expect(
      authorizeDeposit(
        stubOrders({ status: 503, body: { name: 'SERVICE_UNAVAILABLE', debug_id: 'dbg-503' } })
          .orders,
        store,
        booking.id,
        'ORDER-1',
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'paypal_error', httpStatus: 502 });
    expect(store.get(booking.id)!.hold).toMatchObject({ authorizeOutcomeUnknown: true });

    const retry = stubOrders(authorizeReply(booking.id, HELD_AUTH));
    await authorizeDeposit(retry.orders, store, booking.id, 'ORDER-1', NOW);
    expect(retry.requests[0].headers['paypal-request-id']).toBe(
      'slotkeeper-deposit-authorize-ORDER-1-1',
    );
  });

  it('R3: if the replay also fails to reach PayPal, no new order is created', async () => {
    const store = createMemoryBookingStore();
    const booking = await bookingWithOrder(store);
    await authorizeDeposit(stubOrders(networkDrop()).orders, store, booking.id, 'ORDER-1', NOW).catch(
      () => undefined,
    );

    const replay = stubOrders(networkDrop());
    await expect(
      createDepositOrder(replay.orders, store, booking.id, URLS, ONE_MINUTE_LATER),
    ).rejects.toMatchObject({ code: 'network_error' });
    expect(replay.requests).toHaveLength(1);
    expect(replay.requests[0].url).toContain('/authorize');
    expect(store.get(booking.id)!.hold).toMatchObject({
      paypalOrderId: 'ORDER-1',
      authorizeOutcomeUnknown: true,
    });
  });
});
