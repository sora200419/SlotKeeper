import { sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crc32 } from '@/lib/paypal/crc32';

const getAuthorizedPayment = vi.fn();
vi.mock('@/lib/paypal/client', () => ({
  getOrdersController: () => ({ createOrder: vi.fn(), authorizeOrder: vi.fn() }),
  getPaymentsController: () => ({ getAuthorizedPayment, getCapturedPayment: vi.fn(), getRefund: vi.fn() }),
}));

import { GET as eventsRoute } from '@/app/api/bookings/events/route';
import { POST as webhookRoute } from '@/app/api/webhooks/paypal/route';
import { createBooking } from '@/lib/booking/bookings';
import { getBookingStore, type Booking } from '@/lib/booking/store';
import { makeTestCert } from '../helpers/test-cert';

// Throwaway certificate built in memory; no private key is stored in the repository.
const { pem: CERT, privateKey: KEY } = makeTestCert({
  commonName: 'messageverificationcerts.sandbox.paypal.com',
  notBefore: new Date('2026-01-01T00:00:00Z'),
  notAfter: new Date('2049-12-31T00:00:00Z'),
});
const WEBHOOK_ID = 'WH-ROUTE-TEST';
const STAFF = 'staff-token-for-tests';

function webhookRequest(body: string, options: { webhookId?: string } = {}) {
  const transmissionId = `tx-${Math.random()}`;
  const time = new Date().toISOString();
  const message = `${transmissionId}|${time}|${options.webhookId ?? WEBHOOK_ID}|${crc32(Buffer.from(body))}`;
  return new Request('http://app.test/api/webhooks/paypal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'paypal-transmission-id': transmissionId,
      'paypal-transmission-time': time,
      'paypal-transmission-sig': sign('sha256', Buffer.from(message), KEY).toString('base64'),
      'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-route',
      'paypal-auth-algo': 'SHA256withRSA',
    },
    body,
  });
}

function pendingBooking(): Booking {
  const store = getBookingStore();
  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const booking = createBooking(store, { serviceId: 'haircut', customerName: 'Ana', startsAt });
  const pending: Booking = {
    ...booking,
    status: 'deposit_pending',
    hold: {
      paypalOrderId: 'ORDER-1',
      orderAttempt: 1,
      orderCreatedAt: booking.createdAt,
      authorizationId: 'AUTH-1',
      authorizationStatus: 'PENDING',
    },
  };
  store.save(pending);
  return pending;
}

const authEvent = (id = 'WH-EVT-1') =>
  JSON.stringify({ id, event_type: 'PAYMENT.AUTHORIZATION.CREATED', resource: { id: 'AUTH-1' } });

beforeEach(() => {
  for (const key of ['__slotkeeperBookings', '__slotkeeperWebhookEvents', '__slotkeeperWebhookCerts']) {
    (globalThis as Record<string, unknown>)[key] = undefined;
  }
  getAuthorizedPayment.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.stubEnv('PAYPAL_WEBHOOK_ID', WEBHOOK_ID);
  vi.stubEnv('STAFF_API_TOKEN', STAFF);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(CERT, { status: 200 })));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('POST /api/webhooks/paypal', () => {
  it('verifies, applies the event and acknowledges a redelivery as a duplicate', async () => {
    const booking = pendingBooking();
    getAuthorizedPayment.mockResolvedValue({
      result: { id: 'AUTH-1', status: 'CREATED', customId: booking.id, expirationTime: '2026-12-01T00:00:00Z' },
    });

    const first = await webhookRoute(webhookRequest(authEvent()));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ received: true, result: 'updated', bookingId: booking.id });
    expect(getBookingStore().get(booking.id)!.status).toBe('deposit_held');
    // Read once to find the booking, once more under its lock.
    expect(getAuthorizedPayment).toHaveBeenCalledTimes(2);

    // The redelivery is acknowledged without asking PayPal again.
    const again = await webhookRoute(webhookRequest(authEvent()));
    expect(await again.json()).toMatchObject({ result: 'duplicate' });
    expect(getAuthorizedPayment).toHaveBeenCalledTimes(2);
  });

  it('returns 401 for a delivery not signed for this webhook, without touching PayPal', async () => {
    const res = await webhookRoute(webhookRequest(authEvent(), { webhookId: 'WH-OTHER' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_signature', reason: 'bad_signature' });
    expect(getAuthorizedPayment).not.toHaveBeenCalled();
  });

  it('returns 500 missing_config when PAYPAL_WEBHOOK_ID is not set', async () => {
    vi.stubEnv('PAYPAL_WEBHOOK_ID', '');
    const res = await webhookRoute(webhookRequest(authEvent()));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'missing_config', missing: ['PAYPAL_WEBHOOK_ID'] });
  });

  it('R4: refuses an oversized body with 413 before verifying, by header or while streaming', async () => {
    const declared = new Request('http://app.test/api/webhooks/paypal', {
      method: 'POST',
      headers: { 'content-length': String(10 * 1024 * 1024) },
      body: 'x',
    });
    expect((await webhookRoute(declared)).status).toBe(413);

    // No Content-Length: the stream is cut off once it passes the limit, not read to the end.
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const streamed = new Request('http://app.test/api/webhooks/paypal', {
      method: 'POST',
      body: endless,
      duplex: 'half',
    } as RequestInit);
    expect((await webhookRoute(streamed)).status).toBe(413);
    expect(pulled).toBeLessThan(10);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns 400 for a signed body that is not an event', async () => {
    const res = await webhookRoute(webhookRequest('{"hello":"world"}'));
    expect(res.status).toBe(400);
  });

  it('returns 503 (PayPal retries) when the cert download or follow-up read fails transiently', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 502 })));
    expect((await webhookRoute(webhookRequest(authEvent('WH-A')))).status).toBe(503);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(CERT, { status: 200 })));
    getAuthorizedPayment.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    const res = await webhookRoute(webhookRequest(authEvent('WH-B')));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'retry_later' });
  });

  it('acknowledges events for unknown bookings with 200 so PayPal stops retrying', async () => {
    getAuthorizedPayment.mockResolvedValue({ result: { id: 'AUTH-1', status: 'CREATED', customId: 'gone' } });
    const res = await webhookRoute(webhookRequest(authEvent('WH-C')));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: 'ignored' });
  });
});

describe('GET /api/bookings/events', () => {
  it('requires the staff token', async () => {
    const res = await eventsRoute(new Request('http://app.test/api/bookings/events'));
    expect(res.status).toBe(401);
  });

  it('streams every saved booking until the client disconnects', async () => {
    const abort = new AbortController();
    const res = await eventsRoute(
      new Request('http://app.test/api/bookings/events', {
        headers: { Authorization: `Bearer ${STAFF}` },
        signal: abort.signal,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toBe(': connected\n\n');

    // Two saves (created, then deposit pending) -> two events, in order.
    const booking = pendingBooking();
    const events = [];
    for (let i = 0; i < 2; i++) {
      const chunk = decoder.decode((await reader.read()).value);
      expect(chunk).toMatch(/^event: booking\nid: [\w-]+\ndata: .*\n\n$/);
      events.push(JSON.parse(chunk.split('data: ')[1]));
    }
    expect(events.map((e) => [e.id, e.status])).toEqual([
      [booking.id, 'awaiting_deposit'],
      [booking.id, 'deposit_pending'],
    ]);

    abort.abort();
    expect((await reader.read()).done).toBe(true);
  });
});
