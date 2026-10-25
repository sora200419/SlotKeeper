import { ApiError } from '@paypal/paypal-server-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createOrder = vi.fn();
const authorizeOrder = vi.fn();
vi.mock('@/lib/paypal/client', () => ({
  getOrdersController: () => ({ createOrder, authorizeOrder }),
}));

import { POST as createBookingRoute } from '@/app/api/bookings/route';
import { GET as getBookingRoute } from '@/app/api/bookings/[id]/route';
import { POST as authorizeRoute } from '@/app/api/bookings/[id]/deposit/authorize/route';
import { POST as orderRoute } from '@/app/api/bookings/[id]/deposit/order/route';
import { GET as configRoute } from '@/app/api/paypal/config/route';
import { getBookingStore } from '@/lib/booking/store';

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** A booking created through the real route, 24 hours from the real clock (route uses new Date()). */
async function createBookingViaApi() {
  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const res = await createBookingRoute(
    jsonRequest('http://app.test/api/bookings', { serviceId: 'haircut', customerName: 'Ana', startsAt }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

beforeEach(() => {
  (globalThis as { __slotkeeperBookings?: unknown }).__slotkeeperBookings = undefined;
  createOrder.mockReset();
  authorizeOrder.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('NEXT_PUBLIC_PAYPAL_CLIENT_ID', 'public-client-id');
  vi.stubEnv('PAYPAL_CLIENT_SECRET', 'super-secret-value');
  vi.stubEnv('NEXT_PUBLIC_PAYPAL_ENVIRONMENT', 'sandbox');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/bookings', () => {
  it('creates a booking priced from the catalog', async () => {
    const booking = await createBookingViaApi();
    expect(getBookingStore().get(booking.id)).toMatchObject({
      serviceId: 'haircut',
      deposit: { currency: 'USD', cents: 1000 },
      status: 'awaiting_deposit',
    });
  });

  it('returns 400 for a non-JSON body and for invalid input', async () => {
    const notJson = await createBookingRoute(jsonRequest('http://app.test/api/bookings', '{oops'));
    expect(notJson.status).toBe(400);
    const bad = await createBookingRoute(
      jsonRequest('http://app.test/api/bookings', { serviceId: 'massage', customerName: 'Ana' }),
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_input' });
  });
});

describe('GET /api/bookings/[id]', () => {
  it('returns 404 for an unknown booking', async () => {
    const res = await getBookingRoute(new Request('http://app.test'), params('nope'));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/bookings/[id]/deposit/order', () => {
  it('returns the PayPal order id and passes return URLs on the same origin', async () => {
    const booking = await createBookingViaApi();
    createOrder.mockResolvedValue({ result: { id: 'ORDER-9' } });

    const res = await orderRoute(
      new Request(`http://app.test/api/bookings/${booking.id}/deposit/order`, { method: 'POST' }),
      params(booking.id),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orderId: 'ORDER-9' });
    const call = createOrder.mock.calls[0][0];
    expect(call.body.paymentSource.paypal.experienceContext.returnUrl).toBe(
      `http://app.test/book/${booking.id}?paypal=return`,
    );
    expect(call.body.purchaseUnits[0].amount).toEqual({ currencyCode: 'USD', value: '10.00' });
  });

  it('builds return URLs from APP_URL instead of the request Host when it is set', async () => {
    vi.stubEnv('APP_URL', 'https://slotkeeper.example.com/');
    const booking = await createBookingViaApi();
    createOrder.mockResolvedValue({ result: { id: 'ORDER-10' } });

    await orderRoute(
      new Request(`http://evil.test/api/bookings/${booking.id}/deposit/order`, { method: 'POST' }),
      params(booking.id),
    );

    const context = createOrder.mock.calls[0][0].body.paymentSource.paypal.experienceContext;
    expect(context.returnUrl).toBe(`https://slotkeeper.example.com/book/${booking.id}?paypal=return`);
    expect(context.cancelUrl).toBe(`https://slotkeeper.example.com/book/${booking.id}?paypal=cancel`);
  });

  it('S1: an invalid APP_URL is a clear 500 config error, not an unhandled crash', async () => {
    vi.stubEnv('APP_URL', 'not a url');
    const booking = await createBookingViaApi();
    const res = await orderRoute(
      new Request(`http://app.test/api/bookings/${booking.id}/deposit/order`, { method: 'POST' }),
      params(booking.id),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'missing_config' });
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown booking without calling PayPal', async () => {
    const res = await orderRoute(
      new Request('http://app.test/api/bookings/nope/deposit/order', { method: 'POST' }),
      params('nope'),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'booking_not_found' });
    expect(createOrder).not.toHaveBeenCalled();
  });
});

describe('POST /api/bookings/[id]/deposit/authorize', () => {
  it('returns 400 when orderId is missing', async () => {
    const booking = await createBookingViaApi();
    const res = await authorizeRoute(
      jsonRequest(`http://app.test/api/bookings/${booking.id}/deposit/authorize`, {}),
      params(booking.id),
    );
    expect(res.status).toBe(400);
    expect(authorizeOrder).not.toHaveBeenCalled();
  });

  it('holds the deposit and returns the booking with the authorization id', async () => {
    const booking = await createBookingViaApi();
    createOrder.mockResolvedValue({ result: { id: 'ORDER-9' } });
    await orderRoute(
      new Request(`http://app.test/api/bookings/${booking.id}/deposit/order`, { method: 'POST' }),
      params(booking.id),
    );
    authorizeOrder.mockResolvedValue({
      result: {
        id: 'ORDER-9',
        purchaseUnits: [
          {
            payments: {
              authorizations: [
                {
                  id: 'AUTH-9',
                  status: 'CREATED',
                  amount: { currencyCode: 'USD', value: '10.00' },
                  expirationTime: '2026-12-01T00:00:00Z',
                },
              ],
            },
          },
        ],
      },
    });

    const res = await authorizeRoute(
      jsonRequest(`http://app.test/api/bookings/${booking.id}/deposit/authorize`, { orderId: 'ORDER-9' }),
      params(booking.id),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'deposit_held',
      hold: { paypalOrderId: 'ORDER-9', authorizationId: 'AUTH-9' },
    });
    expect(getBookingStore().get(booking.id)!.hold!.authorizationId).toBe('AUTH-9');
  });
});

describe('N5: authorize route maps ORDER_ALREADY_AUTHORIZED to a 409 needs_review body', () => {
  it('returns 409 with error needs_review', async () => {
    const booking = await createBookingViaApi();
    createOrder.mockResolvedValue({ result: { id: 'ORDER-11' } });
    await orderRoute(
      new Request(`http://app.test/api/bookings/${booking.id}/deposit/order`, { method: 'POST' }),
      params(booking.id),
    );
    const apiError = new ApiError(
      {
        request: { method: 'POST', url: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-11/authorize' },
        response: { statusCode: 422, headers: {}, body: '{}' },
      } as unknown as ConstructorParameters<typeof ApiError>[0],
      'HTTP 422',
    );
    apiError.result = { details: [{ issue: 'ORDER_ALREADY_AUTHORIZED' }], debug_id: 'dbg-route' } as never;
    authorizeOrder.mockRejectedValue(apiError);

    const res = await authorizeRoute(
      jsonRequest(`http://app.test/api/bookings/${booking.id}/deposit/authorize`, { orderId: 'ORDER-11' }),
      params(booking.id),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'needs_review', paypalDebugId: 'dbg-route' });
  });
});

describe('GET /api/paypal/config', () => {
  it('returns the public client id and sandbox SDK URL, never the secret', async () => {
    const res = await configRoute();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      clientId: 'public-client-id',
      sdkUrl: 'https://www.sandbox.paypal.com/web-sdk/v6/core',
    });
    expect(JSON.stringify(body)).not.toContain('super-secret-value');
  });

  it('returns 500 missing_config when credentials are absent', async () => {
    vi.stubEnv('NEXT_PUBLIC_PAYPAL_CLIENT_ID', '');
    const res = await configRoute();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'missing_config' });
  });
});
