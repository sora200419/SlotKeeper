import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createOrder = vi.fn();
vi.mock('@/lib/paypal/client', () => ({
  getOrdersController: () => ({ createOrder, authorizeOrder: vi.fn() }),
  getVaultController: () => ({ listCustomerPaymentTokens: vi.fn() }),
}));

import { GET as getBookingRoute } from '@/app/api/bookings/[id]/route';
import { POST as orderRoute } from '@/app/api/bookings/[id]/deposit/order/route';
import { POST as walletChargeRoute } from '@/app/api/bookings/[id]/wallet/charge/route';
import { createBooking } from '@/lib/booking/bookings';
import { getBookingStore, type Booking } from '@/lib/booking/store';

const TOKEN = 'staff-token-for-tests';
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function newBooking(): Booking {
  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return createBooking(getBookingStore(), { serviceId: 'haircut', customerName: 'Ana', startsAt });
}

function walletBooking(): Booking {
  const booking = newBooking();
  const held: Booking = {
    ...booking,
    status: 'no_show_charged',
    hold: {
      paypalOrderId: 'ORDER-1',
      orderAttempt: 1,
      orderCreatedAt: booking.createdAt,
      authorizationId: 'AUTH-1',
      capture: { captureId: 'CAP-1', amountCents: 400, status: 'COMPLETED', reason: 'no_show', capturedAt: booking.createdAt },
      savedWallet: { vaultId: 'VAULT-1', status: 'VAULTED', customerId: 'CUST-1', savedAt: booking.createdAt },
    },
  };
  getBookingStore().save(held);
  return held;
}

beforeEach(() => {
  (globalThis as { __slotkeeperBookings?: unknown }).__slotkeeperBookings = undefined;
  createOrder.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('STAFF_API_TOKEN', TOKEN);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/bookings/[id]/deposit/order with savePayment', () => {
  const post = (id: string, body?: string) =>
    orderRoute(
      new Request(`http://app.test/api/bookings/${id}/deposit/order`, {
        method: 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body,
      }),
      params(id),
    );

  it('passes the opt-in through as vault fields on the order', async () => {
    const booking = newBooking();
    createOrder.mockResolvedValue({ result: { id: 'ORDER-9' } });
    const res = await post(booking.id, JSON.stringify({ savePayment: true }));
    expect(res.status).toBe(200);
    expect(createOrder.mock.calls[0][0].body.paymentSource.paypal.attributes.vault).toMatchObject({
      storeInVault: 'ON_SUCCESS',
      usageType: 'MERCHANT',
    });
  });

  it('still works with no body (no vault fields), and rejects a non-boolean savePayment', async () => {
    const booking = newBooking();
    createOrder.mockResolvedValue({ result: { id: 'ORDER-9' } });
    expect((await post(booking.id)).status).toBe(200);
    expect(createOrder.mock.calls[0][0].body.paymentSource.paypal.attributes).toBeUndefined();
    expect((await post(booking.id, JSON.stringify({ savePayment: 'yes' }))).status).toBe(400);
  });

  it('R7: a JSON content type with an empty body (what older clients send) still works', async () => {
    const booking = newBooking();
    createOrder.mockResolvedValue({ result: { id: 'ORDER-9' } });
    expect((await post(booking.id, '')).status).toBe(200);
  });
});

describe('GET /api/bookings/[id]', () => {
  it('does not reveal the vault or PayPal customer id', async () => {
    const booking = walletBooking();
    const res = await getBookingRoute(new Request('http://app.test'), params(booking.id));
    const text = await res.text();
    expect(text).not.toContain('VAULT-1');
    expect(text).not.toContain('CUST-1');
    expect(JSON.parse(text).hold.savedWallet).toMatchObject({ status: 'VAULTED' });
  });
});

describe('POST /api/bookings/[id]/wallet/charge', () => {
  const charge = (id: string, body: unknown, auth = true) =>
    walletChargeRoute(
      new Request(`http://app.test/api/bookings/${id}/wallet/charge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}) },
        body: JSON.stringify(body),
      }),
      params(id),
    );

  it('is staff-only', async () => {
    const booking = walletBooking();
    expect((await charge(booking.id, { amountCents: 400 }, false)).status).toBe(401);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('charges the saved wallet and returns the booking with the charge', async () => {
    const booking = walletBooking();
    createOrder.mockResolvedValue({
      result: {
        id: 'ORDER-W1',
        status: 'COMPLETED',
        purchaseUnits: [
          { payments: { captures: [{ id: 'CAP-W1', status: 'COMPLETED', amount: { currencyCode: 'USD', value: '4.00' } }] } },
        ],
      },
    });
    const res = await charge(booking.id, { amountCents: 400 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hold: { walletCharges: [{ captureId: 'CAP-W1', amountCents: 400 }] } });
    expect(createOrder.mock.calls[0][0].body.paymentSource.paypal.vaultId).toBe('VAULT-1');
  });

  it('validates amountCents', async () => {
    const booking = walletBooking();
    expect((await charge(booking.id, { amountCents: '4.00' })).status).toBe(400);
    expect(createOrder).not.toHaveBeenCalled();
  });
});
