import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captureAuthorizedPayment = vi.fn();
const voidPayment = vi.fn();
const reauthorizePayment = vi.fn();
const refundCapturedPayment = vi.fn();
vi.mock('@/lib/paypal/client', () => ({
  getPaymentsController: () => ({
    captureAuthorizedPayment,
    voidPayment,
    reauthorizePayment,
    refundCapturedPayment,
  }),
}));

import { POST as captureRoute } from '@/app/api/bookings/[id]/deposit/capture/route';
import { POST as reauthorizeRoute } from '@/app/api/bookings/[id]/deposit/reauthorize/route';
import { POST as refundRoute } from '@/app/api/bookings/[id]/deposit/refund/route';
import { POST as voidRoute } from '@/app/api/bookings/[id]/deposit/void/route';
import { createBooking } from '@/lib/booking/bookings';
import { getBookingStore, type Booking } from '@/lib/booking/store';

const TOKEN = 'staff-token-for-tests';
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function staffRequest(path: string, body?: unknown, headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }) {
  return new Request(`http://app.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function heldBooking(): Booking {
  const store = getBookingStore();
  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const booking = createBooking(store, { serviceId: 'haircut', customerName: 'Ana', startsAt });
  const held: Booking = {
    ...booking,
    status: 'deposit_held',
    hold: {
      paypalOrderId: 'ORDER-1',
      orderAttempt: 1,
      orderCreatedAt: booking.createdAt,
      authorizationId: 'AUTH-1',
      authorizationStatus: 'CREATED',
    },
  };
  store.save(held);
  return held;
}

beforeEach(() => {
  (globalThis as { __slotkeeperBookings?: unknown }).__slotkeeperBookings = undefined;
  for (const fn of [captureAuthorizedPayment, voidPayment, reauthorizePayment, refundCapturedPayment]) {
    fn.mockReset();
  }
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('STAFF_API_TOKEN', TOKEN);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('staff authorization', () => {
  const routes = [
    ['capture', captureRoute, { reason: 'completed' }],
    ['void', voidRoute, undefined],
    ['reauthorize', reauthorizeRoute, undefined],
    ['refund', refundRoute, {}],
  ] as const;

  it.each(routes)('%s returns 503 when STAFF_API_TOKEN is not configured', async (name, route, body) => {
    vi.stubEnv('STAFF_API_TOKEN', '');
    const booking = heldBooking();
    const res = await route(staffRequest(`/api/bookings/${booking.id}/deposit/${name}`, body), params(booking.id));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'staff_disabled' });
  });

  it.each(routes)('%s returns 401 for a missing or wrong token without calling PayPal', async (name, route, body) => {
    const booking = heldBooking();
    const path = `/api/bookings/${booking.id}/deposit/${name}`;
    const missing = await route(staffRequest(path, body, {}), params(booking.id));
    const wrong = await route(staffRequest(path, body, { Authorization: 'Bearer nope' }), params(booking.id));
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: 'unauthorized' });
    for (const fn of [captureAuthorizedPayment, voidPayment, reauthorizePayment, refundCapturedPayment]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('accepts the token in the x-staff-token header too', async () => {
    const booking = heldBooking();
    voidPayment.mockResolvedValue({ result: null });
    const res = await voidRoute(
      staffRequest(`/api/bookings/${booking.id}/deposit/void`, undefined, { 'x-staff-token': TOKEN }),
      params(booking.id),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'cancelled' });
  });
});

describe('POST /api/bookings/[id]/deposit/capture', () => {
  it('validates reason and amountCents before calling PayPal', async () => {
    const booking = heldBooking();
    const path = `/api/bookings/${booking.id}/deposit/capture`;
    expect((await captureRoute(staffRequest(path, { reason: 'later' }), params(booking.id))).status).toBe(400);
    expect(
      (await captureRoute(staffRequest(path, { reason: 'no_show', amountCents: '4.00' }), params(booking.id))).status,
    ).toBe(400);
    expect((await captureRoute(staffRequest(path, '{oops'), params(booking.id))).status).toBe(400);
    expect(captureAuthorizedPayment).not.toHaveBeenCalled();
  });

  it('charges a no-show fee and returns the updated booking', async () => {
    const booking = heldBooking();
    captureAuthorizedPayment.mockResolvedValue({
      result: { id: 'CAP-1', status: 'COMPLETED', amount: { currencyCode: 'USD', value: '4.00' } },
    });
    const res = await captureRoute(
      staffRequest(`/api/bookings/${booking.id}/deposit/capture`, { reason: 'no_show', amountCents: 400 }),
      params(booking.id),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'no_show_charged',
      hold: { capture: { captureId: 'CAP-1', amountCents: 400 } },
    });
    expect(captureAuthorizedPayment.mock.calls[0][0]).toMatchObject({
      authorizationId: 'AUTH-1',
      body: { amount: { currencyCode: 'USD', value: '4.00' }, finalCapture: true },
    });
  });
});

describe('POST /api/bookings/[id]/deposit/refund', () => {
  it('returns 409 invalid_state when nothing was captured', async () => {
    const booking = heldBooking();
    const res = await refundRoute(staffRequest(`/api/bookings/${booking.id}/deposit/refund`, {}), params(booking.id));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'invalid_state' });
    expect(refundCapturedPayment).not.toHaveBeenCalled();
  });
});

describe('POST /api/bookings/[id]/deposit/reauthorize', () => {
  it('returns the booking with the new authorization id', async () => {
    const booking = heldBooking();
    reauthorizePayment.mockResolvedValue({
      result: { id: 'AUTH-2', status: 'CREATED', expirationTime: '2026-12-31T00:00:00Z' },
    });
    const res = await reauthorizeRoute(
      staffRequest(`/api/bookings/${booking.id}/deposit/reauthorize`),
      params(booking.id),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hold: { authorizationId: 'AUTH-2', previousAuthorizationIds: ['AUTH-1'] } });
  });
});
