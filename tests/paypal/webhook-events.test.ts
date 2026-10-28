import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBooking } from '@/lib/booking/bookings';
import {
  createMemoryBookingStore,
  type Booking,
  type BookingStatus,
  type BookingStore,
  type DepositHold,
} from '@/lib/booking/store';
import { authorizeDeposit } from '@/lib/paypal/deposits';
import {
  handleWebhookEvent,
  parseWebhookEvent,
  processWebhookOnce,
  type WebhookEvent,
  type WebhookPayPal,
} from '@/lib/paypal/webhook-events';
import { WebhookRetryableError } from '@/lib/paypal/webhook-signature';
import { networkDrop, stubPayPal, type Reply } from '../helpers/paypal-stub';

// Fixed clock: tests never depend on the real date.
const NOW = new Date('2026-11-01T00:00:00.000Z');
const API = 'https://api-m.sandbox.paypal.com';

function booking(store: BookingStore, status: BookingStatus, hold: Partial<DepositHold> = {}): Booking {
  const created = createBooking(
    store,
    { serviceId: 'haircut', customerName: 'Ana', startsAt: '2026-11-02T10:00:00.000Z' },
    NOW,
  );
  const saved: Booking = {
    ...created,
    status,
    hold: {
      paypalOrderId: 'ORDER-1',
      orderAttempt: 1,
      orderCreatedAt: NOW.toISOString(),
      authorizationId: 'AUTH-1',
      authorizationStatus: 'CREATED',
      ...hold,
    },
  };
  store.save(saved);
  return saved;
}

const event = (eventType: string, resource: Record<string, unknown>): WebhookEvent => ({
  id: `WH-${eventType}`,
  eventType,
  resource,
});
const ok = (body: unknown): Reply => ({ status: 200, body });
/** Handlers read the PayPal object twice: once to find the booking, once under its lock. */
const twice = (reply: Reply): Reply[] => [reply, reply];
const authorization = (bookingId: string, status: string, id = 'AUTH-1', value = '10.00') =>
  ok({
    id,
    status,
    custom_id: bookingId,
    amount: { currency_code: 'USD', value },
    expiration_time: '2026-11-30T00:00:00Z',
  });
const capture = (bookingId: string, status: string, value = '10.00', authorizationId = 'AUTH-1') =>
  ok({
    id: 'CAP-1',
    status,
    custom_id: bookingId,
    amount: { currency_code: 'USD', value },
    supplementary_data: { related_ids: { authorization_id: authorizationId } },
  });
// Real sandbox refunds carry the order's custom_id even when the refund request set none
// (checked 2026-10-26), so `invoiceId` is what tells our refunds from dashboard ones.
const refund = (bookingId: string, status: string, value: string, invoiceId?: string, id = 'REF-1') =>
  ok({
    id,
    status,
    custom_id: bookingId,
    invoice_id: invoiceId,
    amount: { currency_code: 'USD', value },
    links: [{ rel: 'up', method: 'GET', href: `${API}/v2/payments/captures/CAP-1` }],
  });
const recordedCapture = (status = 'COMPLETED', amountCents = 1000) => ({
  captureId: 'CAP-1',
  amountCents,
  status,
  reason: 'completed' as const,
  capturedAt: NOW.toISOString(),
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  (globalThis as { __slotkeeperWebhookEvents?: unknown }).__slotkeeperWebhookEvents = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseWebhookEvent', () => {
  it('reads id, type and resource', () => {
    expect(
      parseWebhookEvent(Buffer.from('{"id":"WH-1","event_type":"X","resource":{"id":"R"}}')),
    ).toEqual({ id: 'WH-1', eventType: 'X', resource: { id: 'R' } });
  });

  it.each(['{oops', '{"event_type":"X"}', '[]'])('rejects %s', (body) => {
    expect(() => parseWebhookEvent(Buffer.from(body))).toThrow(
      expect.objectContaining({ name: 'WebhookPayloadError' }),
    );
  });
});

describe('handleWebhookEvent: routing', () => {
  it('ignores unhandled types and events without a resource id, without calling PayPal', async () => {
    const store = createMemoryBookingStore();
    const paypal = stubPayPal();
    expect(await handleWebhookEvent(paypal, store, event('BILLING.PLAN.CREATED', { id: 'P-1' }))).toMatchObject({
      result: 'ignored',
    });
    expect(await handleWebhookEvent(paypal, store, event('PAYMENT.CAPTURE.COMPLETED', {}))).toMatchObject({
      result: 'ignored',
    });
    expect(paypal.requests).toHaveLength(0);
  });
});

describe('PAYMENT.AUTHORIZATION.*', () => {
  it('moves a pending hold to held once PayPal reports it CREATED (read back, not trusted from the payload)', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'deposit_pending', { authorizationStatus: 'PENDING' });
    const paypal = stubPayPal(...twice(authorization(b.id, 'CREATED')));

    const outcome = await handleWebhookEvent(
      paypal,
      store,
      event('PAYMENT.AUTHORIZATION.CREATED', { id: 'AUTH-1', status: 'VOIDED' }),
      NOW,
    );

    expect(paypal.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${API}/v2/payments/authorizations/AUTH-1`,
      `GET ${API}/v2/payments/authorizations/AUTH-1`,
    ]);
    expect(outcome).toEqual({ result: 'updated', bookingId: b.id });
    expect(store.get(b.id)).toMatchObject({
      status: 'deposit_held',
      hold: { authorizationStatus: 'CREATED', expiresAt: '2026-11-30T00:00:00Z' },
    });
  });

  it('cancels the booking when the hold was voided outside the app, and settles a pending void', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'deposit_held', {
      pendingAction: { kind: 'void', requestId: 'slotkeeper-void-AUTH-1-1', since: NOW.toISOString() },
    });
    const paypal = stubPayPal(...twice(authorization(b.id, 'VOIDED')));
    await handleWebhookEvent(paypal, store, event('PAYMENT.AUTHORIZATION.VOIDED', { id: 'AUTH-1' }), NOW);
    expect(store.get(b.id)).toMatchObject({
      status: 'cancelled',
      hold: { authorizationStatus: 'VOIDED', voidedAt: NOW.toISOString() },
    });
    expect(store.get(b.id)!.hold!.pendingAction).toBeUndefined();
  });

  it('sends an expired or denied hold to staff review', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'deposit_held');
    const paypal = stubPayPal(...twice(authorization(b.id, 'EXPIRED')));
    await handleWebhookEvent(paypal, store, event('PAYMENT.AUTHORIZATION.VOIDED', { id: 'AUTH-1' }), NOW);
    expect(store.get(b.id)!.status).toBe('deposit_needs_review');
  });

  it('leaves a captured booking alone when its authorization is reported voided', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'completed', { capture: recordedCapture() });
    const paypal = stubPayPal(...twice(authorization(b.id, 'VOIDED')));
    expect(
      await handleWebhookEvent(paypal, store, event('PAYMENT.AUTHORIZATION.VOIDED', { id: 'AUTH-1' }), NOW),
    ).toMatchObject({ result: 'unchanged' });
    expect(store.get(b.id)!.status).toBe('completed');
  });

  it('ignores events for an authorization that was replaced by a reauthorization', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'deposit_held', { authorizationId: 'AUTH-2', previousAuthorizationIds: ['AUTH-1'] });
    const paypal = stubPayPal(...twice(authorization(b.id, 'VOIDED', 'AUTH-1')));
    expect(
      await handleWebhookEvent(paypal, store, event('PAYMENT.AUTHORIZATION.VOIDED', { id: 'AUTH-1' }), NOW),
    ).toMatchObject({ result: 'ignored' });
    expect(store.get(b.id)!.status).toBe('deposit_held');
  });

  it('R3: adopts the new authorization of a staff reauthorization whose answer was lost', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'deposit_held', {
      pendingAction: { kind: 'reauthorize', requestId: 'r', amountCents: 1000, since: NOW.toISOString() },
    });
    const paypal = stubPayPal(...twice(authorization(b.id, 'CREATED', 'AUTH-2')));
    await handleWebhookEvent(paypal, store, event('PAYMENT.AUTHORIZATION.CREATED', { id: 'AUTH-2' }), NOW);
    const saved = store.get(b.id)!;
    expect(saved.status).toBe('deposit_held');
    expect(saved.hold).toMatchObject({ authorizationId: 'AUTH-2', previousAuthorizationIds: ['AUTH-1'] });
    expect(saved.hold!.pendingAction).toBeUndefined();
  });

  it('S4: a lost reauthorization for a different amount is adopted but sent to staff review', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'deposit_held', {
      pendingAction: { kind: 'reauthorize', requestId: 'r', amountCents: 1000, since: NOW.toISOString() },
    });
    const paypal = stubPayPal(...twice(authorization(b.id, 'CREATED', 'AUTH-2', '11.50')));
    await handleWebhookEvent(paypal, store, event('PAYMENT.AUTHORIZATION.CREATED', { id: 'AUTH-2' }), NOW);
    expect(store.get(b.id)).toMatchObject({ status: 'deposit_needs_review', hold: { authorizationId: 'AUTH-2' } });
  });

  it('R3: never adopts a replaced (old) authorization as the reauthorization result', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'deposit_held', {
      authorizationId: 'AUTH-2',
      previousAuthorizationIds: ['AUTH-1'],
      pendingAction: { kind: 'reauthorize', requestId: 'r', amountCents: 1000, since: NOW.toISOString() },
    });
    const paypal = stubPayPal(...twice(authorization(b.id, 'CREATED', 'AUTH-1')));
    expect(
      await handleWebhookEvent(paypal, store, event('PAYMENT.AUTHORIZATION.CREATED', { id: 'AUTH-1' }), NOW),
    ).toMatchObject({ result: 'ignored' });
    expect(store.get(b.id)!.hold).toMatchObject({ authorizationId: 'AUTH-2', pendingAction: { kind: 'reauthorize' } });
  });

  it('ignores a 404 (not ours) but asks PayPal to retry after a 5xx or a network drop', async () => {
    const store = createMemoryBookingStore();
    const paypal = stubPayPal(
      { status: 404, body: { name: 'RESOURCE_NOT_FOUND', debug_id: 'dbg-404' } },
      { status: 500, body: { name: 'INTERNAL_SERVER_ERROR', debug_id: 'dbg-500' } },
      networkDrop(),
    );
    const e = event('PAYMENT.AUTHORIZATION.CREATED', { id: 'AUTH-X' });
    expect(await handleWebhookEvent(paypal, store, e, NOW)).toMatchObject({ result: 'ignored' });
    await expect(handleWebhookEvent(paypal, store, e, NOW)).rejects.toBeInstanceOf(WebhookRetryableError);
    await expect(handleWebhookEvent(paypal, store, e, NOW)).rejects.toBeInstanceOf(WebhookRetryableError);
  });
});

describe('PAYMENT.CAPTURE.*', () => {
  it('updates a recorded PENDING capture to COMPLETED', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'completed', { capture: recordedCapture('PENDING') });
    const paypal = stubPayPal(...twice(capture(b.id, 'COMPLETED')));
    await handleWebhookEvent(paypal, store, event('PAYMENT.CAPTURE.COMPLETED', { id: 'CAP-1' }), NOW);
    expect(paypal.requests[0].url).toBe(`${API}/v2/payments/captures/CAP-1`);
    expect(store.get(b.id)).toMatchObject({ status: 'completed', hold: { capture: { status: 'COMPLETED' } } });
  });

  it('sends a recorded capture that PayPal later declined to staff review', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'completed', { capture: recordedCapture('PENDING') });
    const paypal = stubPayPal(...twice(capture(b.id, 'DECLINED')));
    await handleWebhookEvent(paypal, store, event('PAYMENT.CAPTURE.DECLINED', { id: 'CAP-1' }), NOW);
    expect(store.get(b.id)).toMatchObject({ status: 'deposit_needs_review', hold: { capture: { status: 'DECLINED' } } });
  });

  it('R1: an event that waited for the lock applies PayPal\'s latest state, not the one it first read', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'completed', { capture: recordedCapture('PENDING') });
    const snapshot = (status: string) => ({
      result: {
        id: 'CAP-1',
        status,
        customId: b.id,
        amount: { currencyCode: 'USD', value: '10.00' },
        supplementaryData: { relatedIds: { authorizationId: 'AUTH-1' } },
      },
    });
    // PayPal's state is PENDING when event A first reads it; A's answer is held back on the wire.
    let paypalStatus = 'PENDING';
    let releaseStaleRead!: () => void;
    let calls = 0;
    const paypal = {
      payments: {
        getCapturedPayment: () => {
          calls++;
          if (calls === 1) {
            const stale = snapshot(paypalStatus);
            return new Promise((resolve) => (releaseStaleRead = () => resolve(stale)));
          }
          return Promise.resolve(snapshot(paypalStatus));
        },
      },
    } as unknown as WebhookPayPal;

    const late = handleWebhookEvent(paypal, store, event('PAYMENT.CAPTURE.PENDING', { id: 'CAP-1' }), NOW);
    // PayPal completes the capture; event B arrives and is fully applied first.
    paypalStatus = 'COMPLETED';
    await handleWebhookEvent(paypal, store, event('PAYMENT.CAPTURE.COMPLETED', { id: 'CAP-1' }), NOW);
    expect(store.get(b.id)!.hold!.capture!.status).toBe('COMPLETED');

    // Only now does A's stale PENDING answer arrive. A must not write it over COMPLETED.
    releaseStaleRead();
    await late;
    expect(store.get(b.id)!.hold!.capture!.status).toBe('COMPLETED');
  });

  it('settles a staff capture whose answer was lost (outcome unknown)', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'deposit_held', {
      pendingAction: {
        kind: 'capture',
        requestId: 'slotkeeper-capture-AUTH-1-1',
        amountCents: 400,
        reason: 'no_show',
        since: NOW.toISOString(),
      },
    });
    const paypal = stubPayPal(...twice(capture(b.id, 'COMPLETED', '4.00')));
    await handleWebhookEvent(paypal, store, event('PAYMENT.CAPTURE.COMPLETED', { id: 'CAP-1' }), NOW);
    const saved = store.get(b.id)!;
    expect(saved.status).toBe('no_show_charged');
    expect(saved.hold!.capture).toMatchObject({ captureId: 'CAP-1', amountCents: 400, reason: 'no_show' });
    expect(saved.hold!.pendingAction).toBeUndefined();
  });

  it('a lost capture that settled for a different amount goes to staff review', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'deposit_held', {
      pendingAction: { kind: 'capture', requestId: 'r', amountCents: 400, reason: 'no_show', since: NOW.toISOString() },
    });
    const paypal = stubPayPal(...twice(capture(b.id, 'COMPLETED', '5.00')));
    await handleWebhookEvent(paypal, store, event('PAYMENT.CAPTURE.COMPLETED', { id: 'CAP-1' }), NOW);
    expect(store.get(b.id)).toMatchObject({ status: 'deposit_needs_review', hold: { capture: { amountCents: 500 } } });
  });

  it('a lost capture that was declined clears the pending action and bumps the attempt', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'deposit_held', {
      pendingAction: { kind: 'capture', requestId: 'r', amountCents: 1000, reason: 'completed', since: NOW.toISOString() },
    });
    const paypal = stubPayPal(...twice(capture(b.id, 'DECLINED')));
    await handleWebhookEvent(paypal, store, event('PAYMENT.CAPTURE.DECLINED', { id: 'CAP-1' }), NOW);
    const hold = store.get(b.id)!.hold!;
    expect(store.get(b.id)!.status).toBe('deposit_held');
    expect(hold.pendingAction).toBeUndefined();
    expect(hold.actionAttempts).toEqual({ capture: 2 });
    expect(hold.capture).toBeUndefined();
  });

  it('R7: a capture made outside the app is recorded and goes to staff review', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'deposit_held');
    const paypal = stubPayPal(...twice(capture(b.id, 'COMPLETED', '6.00')));
    await handleWebhookEvent(paypal, store, event('PAYMENT.CAPTURE.COMPLETED', { id: 'CAP-1' }), NOW);
    expect(store.get(b.id)).toMatchObject({
      status: 'deposit_needs_review',
      hold: { capture: { captureId: 'CAP-1', amountCents: 600, reason: 'external' } },
    });
  });

  it('ignores a capture of an authorization that is not this booking\'s hold', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'deposit_held');
    const paypal = stubPayPal(...twice(capture(b.id, 'COMPLETED', '10.00', 'AUTH-OTHER')));
    expect(
      await handleWebhookEvent(paypal, store, event('PAYMENT.CAPTURE.COMPLETED', { id: 'CAP-1' }), NOW),
    ).toMatchObject({ result: 'ignored' });
    expect(store.get(b.id)!.status).toBe('deposit_held');
  });
});

describe('PAYMENT.CAPTURE.* for saved-wallet charges (R3)', () => {
  const walletCapture = (bookingId: string, status: string, invoiceId: string, value = '4.00') =>
    ok({
      id: 'CAP-W1',
      status,
      custom_id: bookingId,
      invoice_id: invoiceId,
      amount: { currency_code: 'USD', value },
      supplementary_data: { related_ids: { order_id: 'ORDER-W1' } },
    });
  const charged = (status: string) => ({
    orderId: 'ORDER-W1',
    captureId: 'CAP-W1',
    amountCents: 400,
    status,
    chargedAt: NOW.toISOString(),
  });

  it('updates a recorded PENDING wallet charge to COMPLETED', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'deposit_held', { walletCharges: [charged('PENDING')] });
    const paypal = stubPayPal(...twice(walletCapture(b.id, 'COMPLETED', `${b.id}-wallet-1-1`)));
    await handleWebhookEvent(paypal, store, event('PAYMENT.CAPTURE.COMPLETED', { id: 'CAP-W1' }), NOW);
    expect(store.get(b.id)).toMatchObject({ status: 'deposit_held', hold: { walletCharges: [{ status: 'COMPLETED' }] } });
  });

  it('sends a recorded wallet charge that PayPal later declined to staff review', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'deposit_held', { walletCharges: [charged('PENDING')] });
    const paypal = stubPayPal(...twice(walletCapture(b.id, 'DECLINED', `${b.id}-wallet-1-1`)));
    await handleWebhookEvent(paypal, store, event('PAYMENT.CAPTURE.DECLINED', { id: 'CAP-W1' }), NOW);
    expect(store.get(b.id)).toMatchObject({
      status: 'deposit_needs_review',
      hold: { walletCharges: [{ status: 'DECLINED' }] },
    });
  });

  it('settles a wallet charge whose answer was lost, matched on its exact invoice id', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'deposit_held', {
      pendingAction: {
        kind: 'wallet_charge',
        requestId: '',
        amountCents: 400,
        since: NOW.toISOString(),
      },
    });
    const pending = store.get(b.id)!;
    store.save({
      ...pending,
      hold: { ...pending.hold!, pendingAction: { ...pending.hold!.pendingAction!, requestId: `slotkeeper-wallet_charge-${b.id}-1-1` } },
    });
    const paypal = stubPayPal(...twice(walletCapture(b.id, 'COMPLETED', `${b.id}-wallet-1-1`)));
    await handleWebhookEvent(paypal, store, event('PAYMENT.CAPTURE.COMPLETED', { id: 'CAP-W1' }), NOW);
    const saved = store.get(b.id)!;
    expect(saved.status).toBe('deposit_held');
    expect(saved.hold!.pendingAction).toBeUndefined();
    expect(saved.hold!.walletCharges).toMatchObject([{ orderId: 'ORDER-W1', captureId: 'CAP-W1', amountCents: 400 }]);
  });

  it('a wallet capture with another invoice id does not settle the pending charge', async () => {
    const store = createMemoryBookingStore();
    const created = booking(store, 'deposit_held');
    store.save({
      ...created,
      hold: {
        ...created.hold!,
        pendingAction: {
          kind: 'wallet_charge',
          requestId: `slotkeeper-wallet_charge-${created.id}-2-1`,
          amountCents: 400,
          since: NOW.toISOString(),
        },
      },
    });
    const paypal = stubPayPal(...twice(walletCapture(created.id, 'COMPLETED', `${created.id}-wallet-1-1`)));
    await handleWebhookEvent(paypal, store, event('PAYMENT.CAPTURE.COMPLETED', { id: 'CAP-W1' }), NOW);
    expect(store.get(created.id)!.hold!.pendingAction).toMatchObject({ kind: 'wallet_charge' });
    expect(store.get(created.id)!.hold!.walletCharges).toBeUndefined();
  });
});

describe('PAYMENT.CAPTURE.REFUNDED', () => {
  it('updates a known refund\'s status', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'partially_refunded', {
      capture: recordedCapture(),
      refunds: [{ refundId: 'REF-1', amountCents: 300, status: 'PENDING', refundedAt: NOW.toISOString() }],
    });
    const paypal = stubPayPal(...twice(refund(b.id, 'COMPLETED', '3.00', `${b.id}-refund-1-1`)));
    await handleWebhookEvent(paypal, store, event('PAYMENT.CAPTURE.REFUNDED', { id: 'REF-1' }), NOW);
    expect(paypal.requests[0].url).toBe(`${API}/v2/payments/refunds/REF-1`);
    expect(store.get(b.id)).toMatchObject({
      status: 'partially_refunded',
      hold: { refunds: [{ refundId: 'REF-1', status: 'COMPLETED' }] },
    });
  });

  it('records a refund made in the PayPal dashboard', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'completed', { capture: recordedCapture() });
    const paypal = stubPayPal(...twice(refund(b.id, 'COMPLETED', '10.00')));
    await handleWebhookEvent(paypal, store, event('PAYMENT.CAPTURE.REFUNDED', { id: 'REF-1' }), NOW);
    expect(store.get(b.id)).toMatchObject({
      status: 'refunded',
      hold: { refunds: [{ refundId: 'REF-1', amountCents: 1000 }] },
    });
  });

  it('settles a staff refund whose answer was lost', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'completed', {
      capture: recordedCapture(),
      pendingAction: {
        kind: 'refund',
        requestId: 'slotkeeper-refund-CAP-1-1-1',
        amountCents: 250,
        since: NOW.toISOString(),
      },
    });
    const paypal = stubPayPal(...twice(refund(b.id, 'COMPLETED', '2.50', `${b.id}-refund-1-1`)));
    await handleWebhookEvent(paypal, store, event('PAYMENT.CAPTURE.REFUNDED', { id: 'REF-1' }), NOW);
    const saved = store.get(b.id)!;
    expect(saved.status).toBe('partially_refunded');
    expect(saved.hold!.pendingAction).toBeUndefined();
    expect(saved.hold!.refunds).toMatchObject([{ refundId: 'REF-1', amountCents: 250 }]);
  });

  it('S2: an older refund of ours does not settle a newer pending refund', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'completed', {
      capture: recordedCapture(),
      pendingAction: {
        kind: 'refund',
        requestId: 'slotkeeper-refund-CAP-1-2-1',
        amountCents: 250,
        since: NOW.toISOString(),
      },
    });
    const paypal = stubPayPal(...twice(refund(b.id, 'COMPLETED', '2.50', `${b.id}-refund-1-1`)));
    await handleWebhookEvent(paypal, store, event('PAYMENT.CAPTURE.REFUNDED', { id: 'REF-1' }), NOW);
    expect(store.get(b.id)!.hold!.pendingAction).toMatchObject({ requestId: 'slotkeeper-refund-CAP-1-2-1' });
  });

  it('R2: a dashboard refund does not settle a pending staff refund, even with the same amount', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'completed', {
      capture: recordedCapture(),
      pendingAction: { kind: 'refund', requestId: 'r', amountCents: 250, since: NOW.toISOString() },
    });
    const paypal = stubPayPal(...twice(refund(b.id, 'COMPLETED', '2.50', undefined, 'REF-DASH')));
    await handleWebhookEvent(paypal, store, event('PAYMENT.CAPTURE.REFUNDED', { id: 'REF-DASH' }), NOW);
    const saved = store.get(b.id)!;
    expect(saved.hold!.refunds).toMatchObject([{ refundId: 'REF-DASH', amountCents: 250 }]);
    expect(saved.hold!.pendingAction).toMatchObject({ kind: 'refund', amountCents: 250 });
  });

  it('a replayed event for an already-recorded refund changes nothing', async () => {
    const store = createMemoryBookingStore();
    const b = booking(store, 'refunded', {
      capture: recordedCapture(),
      refunds: [{ refundId: 'REF-1', amountCents: 1000, status: 'COMPLETED', refundedAt: NOW.toISOString() }],
    });
    const paypal = stubPayPal(...twice(refund(b.id, 'COMPLETED', '10.00', `${b.id}-refund-1-1`)));
    expect(
      await handleWebhookEvent(paypal, store, event('PAYMENT.CAPTURE.REFUNDED', { id: 'REF-1' }), NOW),
    ).toMatchObject({ result: 'unchanged' });
    expect(store.get(b.id)!.hold!.refunds).toHaveLength(1);
  });
});

describe('CHECKOUT.ORDER.APPROVED', () => {
  const approved = (bookingId: string, orderId = 'ORDER-1') =>
    event('CHECKOUT.ORDER.APPROVED', { id: orderId, purchase_units: [{ custom_id: bookingId }] });
  const authorizeReply = (bookingId: string): Reply => ({
    status: 201,
    body: {
      id: 'ORDER-1',
      status: 'COMPLETED',
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
  const awaiting = (store: BookingStore) =>
    booking(store, 'awaiting_deposit', { authorizationId: undefined, authorizationStatus: undefined });

  it('completes the hold when the customer closed the tab after approving', async () => {
    const store = createMemoryBookingStore();
    const b = awaiting(store);
    const paypal = stubPayPal(authorizeReply(b.id));
    expect(await handleWebhookEvent(paypal, store, approved(b.id), NOW)).toMatchObject({ result: 'updated' });
    expect(paypal.requests[0].url).toBe(`${API}/v2/checkout/orders/ORDER-1/authorize`);
    expect(store.get(b.id)).toMatchObject({ status: 'deposit_held', hold: { authorizationId: 'AUTH-1' } });
  });

  it('does nothing when the browser already authorized, or the order is not the booking\'s', async () => {
    const store = createMemoryBookingStore();
    const held = booking(store, 'deposit_held');
    const pending = awaiting(store);
    const paypal = stubPayPal();
    expect(await handleWebhookEvent(paypal, store, approved(held.id), NOW)).toMatchObject({ result: 'unchanged' });
    expect(await handleWebhookEvent(paypal, store, approved(pending.id, 'ORDER-OTHER'), NOW)).toMatchObject({
      result: 'unchanged',
    });
    expect(await handleWebhookEvent(paypal, store, approved('no-such-booking'), NOW)).toMatchObject({
      result: 'ignored',
    });
    expect(paypal.requests).toHaveLength(0);
  });

  it('browser and webhook authorizing at once: one PayPal call, both end with the hold', async () => {
    const store = createMemoryBookingStore();
    const b = awaiting(store);
    const paypal = stubPayPal(authorizeReply(b.id));

    const [browser, webhook] = await Promise.all([
      authorizeDeposit(paypal.orders, store, b.id, 'ORDER-1', NOW),
      handleWebhookEvent(paypal, store, approved(b.id), NOW),
    ]);

    expect(paypal.requests).toHaveLength(1);
    expect(browser.status).toBe('deposit_held');
    expect(webhook).toMatchObject({ result: 'unchanged' });
    expect(store.get(b.id)!.hold!.authorizationId).toBe('AUTH-1');
  });

  it('asks PayPal to retry when authorizing fails transiently', async () => {
    const store = createMemoryBookingStore();
    const b = awaiting(store);
    const paypal = stubPayPal({ status: 503, body: { name: 'SERVICE_UNAVAILABLE', debug_id: 'dbg-503' } });
    await expect(handleWebhookEvent(paypal, store, approved(b.id), NOW)).rejects.toBeInstanceOf(
      WebhookRetryableError,
    );
  });
});

describe('processWebhookOnce', () => {
  it('runs an event once and acknowledges redeliveries as duplicates', async () => {
    const run = vi.fn(async () => ({ result: 'updated' as const }));
    expect(await processWebhookOnce('WH-1', run)).toEqual({ result: 'updated' });
    expect(await processWebhookOnce('WH-1', run)).toEqual({ result: 'duplicate' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not remember a failed event, so the redelivery is processed', async () => {
    const run = vi
      .fn<() => Promise<{ result: 'updated' }>>()
      .mockRejectedValueOnce(new WebhookRetryableError('PayPal down'))
      .mockResolvedValueOnce({ result: 'updated' });
    await expect(processWebhookOnce('WH-2', run)).rejects.toBeInstanceOf(WebhookRetryableError);
    expect(await processWebhookOnce('WH-2', run)).toEqual({ result: 'updated' });
  });

  it('a second copy arriving while the first is running is sent back for retry', async () => {
    let finish!: () => void;
    const slow = () =>
      new Promise<{ result: 'updated' }>((resolve) => {
        finish = () => resolve({ result: 'updated' });
      });
    const first = processWebhookOnce('WH-3', slow);
    await expect(processWebhookOnce('WH-3', slow)).rejects.toBeInstanceOf(WebhookRetryableError);
    finish();
    expect(await first).toEqual({ result: 'updated' });
  });
});
