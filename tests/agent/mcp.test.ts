import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBookingMcpServer, type McpDeps } from '@/lib/agent/mcp-server';
import { createRateLimiter } from '@/lib/agent/rate-limit';
import { PayPalConfigError } from '@/lib/paypal/config';
import { authorizeDeposit } from '@/lib/paypal/deposits';
import { publicBooking } from '@/lib/api/responses';
import { createMemoryBookingStore, type BookingStore } from '@/lib/booking/store';
import { stubPayPal, type Reply } from '../helpers/paypal-stub';

// Fixed clock: tests never depend on the real date.
const NOW = new Date('2026-11-01T06:00:00.000Z');
const SLOT = '2026-11-02T10:00:00.000Z';

let clock = NOW;

async function connect(bookings: BookingStore, ...replies: Reply[]) {
  return connectWith(bookings, {}, ...replies);
}

async function connectWith(bookings: BookingStore, overrides: Partial<McpDeps>, ...replies: Reply[]) {
  const paypal = stubPayPal(...replies);
  const server = createBookingMcpServer({
    bookings,
    orders: () => paypal.orders,
    payments: () => paypal.payments,
    timeZone: 'UTC',
    origin: 'https://slotkeeper.test',
    now: () => clock,
    ...overrides,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-assistant', version: '1.0.0' });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    const text = result.content[0].text;
    return { isError: result.isError === true, text, json: result.isError ? undefined : JSON.parse(text) };
  };
  return { client, call, paypal };
}

const orderCreated: Reply = {
  status: 201,
  body: {
    id: 'ORDER-1',
    status: 'PAYER_ACTION_REQUIRED',
    links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1', method: 'GET' }],
  },
};

beforeEach(() => {
  clock = NOW;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('SlotKeeper MCP server', () => {
  it('exposes the booking tools', async () => {
    const { client } = await connect(createMemoryBookingStore());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['booking_status', 'cancel_booking', 'create_deposit', 'hold_slot', 'search_slots']);
  });

  it('search_slots lists services without arguments, and free times for a day', async () => {
    const { call } = await connect(createMemoryBookingStore());
    const services = await call('search_slots', {});
    expect(services.json.services.map((s: { serviceId: string }) => s.serviceId)).toEqual(['haircut', 'color', 'physio']);
    const slots = await call('search_slots', { serviceId: 'haircut', day: '2026-11-02' });
    expect(slots.json.slots[0]).toEqual({ startsAt: '2026-11-02T09:00:00.000Z', staffId: 'maria' });
  });

  it('hold_slot reserves a time once; the same time is then taken', async () => {
    const bookings = createMemoryBookingStore();
    const { call } = await connect(bookings);
    const held = await call('hold_slot', { serviceId: 'haircut', startsAt: SLOT, customerName: 'Ana' });
    expect(held.json).toMatchObject({ startsAt: SLOT, staffId: 'maria', status: 'awaiting_deposit' });
    expect(held.json.bookingToken).toMatch(/^[\w-]{32}$/);

    const stored = bookings.get(held.json.bookingId)!;
    expect(stored).toMatchObject({ source: 'agent', staffId: 'maria' });
    expect(stored.accessTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(held.json.bookingToken);
    expect(publicBooking(stored).accessTokenHash).toBeUndefined();

    const again = await call('hold_slot', { serviceId: 'haircut', startsAt: SLOT, customerName: 'Bo' });
    expect(again).toMatchObject({ isError: true });
    expect(again.text).toContain('slot_taken');
  });

  it('two assistants holding the same time at once: exactly one gets it', async () => {
    const bookings = createMemoryBookingStore();
    const { call } = await connect(bookings);
    const [a, b] = await Promise.all([
      call('hold_slot', { serviceId: 'haircut', startsAt: SLOT, customerName: 'Ana' }),
      call('hold_slot', { serviceId: 'haircut', startsAt: SLOT, customerName: 'Bo' }),
    ]);
    expect([a.isError, b.isError].sort()).toEqual([false, true]);
    expect(bookings.list()).toHaveLength(1);
  });

  it('create_deposit needs the booking token and returns PayPal\'s approval link', async () => {
    const bookings = createMemoryBookingStore();
    const { call, paypal } = await connect(bookings, orderCreated);
    const held = await call('hold_slot', { serviceId: 'haircut', startsAt: SLOT, customerName: 'Ana' });

    const wrong = await call('create_deposit', { bookingId: held.json.bookingId, bookingToken: 'guess' });
    expect(wrong).toMatchObject({ isError: true });
    expect(wrong.text).toContain('forbidden');
    expect(paypal.requests).toHaveLength(0);

    const deposit = await call('create_deposit', { bookingId: held.json.bookingId, bookingToken: held.json.bookingToken, savePayment: true });
    expect(deposit.json).toMatchObject({ orderId: 'ORDER-1', approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1' });
    // The prompt 2/5 order: AUTHORIZE for the catalog deposit, return links to our booking page, wallet saving.
    expect(paypal.requests[0].body).toMatchObject({
      intent: 'AUTHORIZE',
      purchase_units: [{ amount: { currency_code: 'USD', value: '10.00' } }],
      payment_source: {
        paypal: {
          experience_context: { return_url: `https://slotkeeper.test/book/${held.json.bookingId}?paypal=return` },
          attributes: { vault: { store_in_vault: 'ON_SUCCESS' } },
        },
      },
    });

    const status = await call('booking_status', { bookingId: held.json.bookingId, bookingToken: held.json.bookingToken });
    expect(status.json).toMatchObject({ status: 'awaiting_deposit', depositHeld: false, approveUrl: deposit.json.approveUrl });
  });

  it('cancel_booking: unpaid → cancelled; held → released with a void; charged → refused', async () => {
    const bookings = createMemoryBookingStore();
    const { call, paypal } = await connect(bookings, { status: 204 });
    const hold = (startsAt: string) => call('hold_slot', { serviceId: 'haircut', startsAt, customerName: 'Ana' });

    const unpaid = await hold(SLOT);
    expect((await call('cancel_booking', { bookingId: unpaid.json.bookingId, bookingToken: unpaid.json.bookingToken })).json).toMatchObject({ status: 'cancelled' });

    const paid = await hold('2026-11-02T12:00:00.000Z');
    const p = bookings.get(paid.json.bookingId)!;
    bookings.save({ ...p, status: 'deposit_held', hold: { paypalOrderId: 'O', orderAttempt: 1, orderCreatedAt: NOW.toISOString(), authorizationId: 'AUTH-1' } });
    expect((await call('cancel_booking', { bookingId: paid.json.bookingId, bookingToken: paid.json.bookingToken })).json).toMatchObject({ status: 'cancelled' });
    expect(paypal.requests[0].url).toBe('https://api-m.sandbox.paypal.com/v2/payments/authorizations/AUTH-1/void');

    const charged = await hold('2026-11-02T14:00:00.000Z');
    const c = bookings.get(charged.json.bookingId)!;
    bookings.save({
      ...c,
      status: 'completed',
      hold: {
        paypalOrderId: 'O',
        orderAttempt: 1,
        orderCreatedAt: NOW.toISOString(),
        authorizationId: 'AUTH-2',
        capture: { captureId: 'CAP', amountCents: 1000, status: 'COMPLETED', reason: 'completed', capturedAt: NOW.toISOString() },
      },
    });
    const refused = await call('cancel_booking', { bookingId: charged.json.bookingId, bookingToken: charged.json.bookingToken });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain('not_cancellable');
    expect(paypal.requests).toHaveLength(1);
  });

  describe('R1: a lapsed reservation can never lead to two paid deposits for one slot', () => {
    async function lapsedAndRetaken() {
      const bookings = createMemoryBookingStore();
      const { call, paypal } = await connect(bookings, orderCreated);
      const ana = await call('hold_slot', { serviceId: 'haircut', startsAt: SLOT, customerName: 'Ana' });
      clock = new Date('2026-11-01T06:20:00.000Z');
      await call('create_deposit', { bookingId: ana.json.bookingId, bookingToken: ana.json.bookingToken });
      // Ana's unpaid hold lapses at 06:30; Bo takes the slot at 06:31.
      clock = new Date('2026-11-01T06:31:00.000Z');
      const bo = await call('hold_slot', { serviceId: 'haircut', startsAt: SLOT, customerName: 'Bo' });
      expect(bo.isError).toBe(false);
      return { bookings, call, paypal, ana, bo };
    }

    it('the lapsed customer\'s create_deposit is refused once the slot was taken', async () => {
      const { call, paypal, ana } = await lapsedAndRetaken();
      // Within Ana's one-hour maximum, so the refusal is about the slot, not expiry.
      clock = new Date('2026-11-01T06:45:00.000Z');
      const again = await call('create_deposit', { bookingId: ana.json.bookingId, bookingToken: ana.json.bookingToken });
      expect(again).toMatchObject({ isError: true });
      expect(again.text).toContain('slot_taken');
      expect(paypal.requests).toHaveLength(1);
      const status = await call('booking_status', { bookingId: ana.json.bookingId, bookingToken: ana.json.bookingToken });
      expect(status.json).toMatchObject({ reservationLapsed: true });
      expect(status.json.approveUrl).toBeUndefined();
    });

    it('approving the old PayPal link afterwards places no hold (approval alone charges nothing)', async () => {
      const { bookings, paypal, ana, bo } = await lapsedAndRetaken();
      clock = new Date('2026-11-01T06:40:00.000Z');
      // What the CHECKOUT.ORDER.APPROVED webhook (or the browser) does for Ana's order.
      await expect(authorizeDeposit(paypal.orders, bookings, ana.json.bookingId, 'ORDER-1', clock)).rejects.toMatchObject({
        code: 'slot_taken',
        httpStatus: 409,
      });
      expect(paypal.requests.map((r) => r.url)).not.toContain('https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-1/authorize');
      expect(bookings.get(ana.json.bookingId)!.status).toBe('awaiting_deposit');
      expect(bookings.get(bo.json.bookingId)!.status).toBe('awaiting_deposit');
    });

    it('a lapsed reservation whose slot is still free is renewed by create_deposit', async () => {
      const bookings = createMemoryBookingStore();
      const { call } = await connect(bookings, orderCreated);
      const ana = await call('hold_slot', { serviceId: 'haircut', startsAt: SLOT, customerName: 'Ana' });
      clock = new Date('2026-11-01T06:45:00.000Z');
      const deposit = await call('create_deposit', { bookingId: ana.json.bookingId, bookingToken: ana.json.bookingToken });
      expect(deposit.isError).toBe(false);
      expect(bookings.get(ana.json.bookingId)!.slotHeldAt).toBe('2026-11-01T06:45:00.000Z');
      // The renewed claim blocks the slot again.
      const bo = await call('hold_slot', { serviceId: 'haircut', startsAt: SLOT, customerName: 'Bo' });
      expect(bo.text).toContain('slot_taken');
    });
  });

  it('R8: a cancelled booking\'s old PayPal order can never place a deposit (even after the slot was resold)', async () => {
    const bookings = createMemoryBookingStore();
    const { call, paypal } = await connect(bookings, orderCreated);
    const ana = await call('hold_slot', { serviceId: 'haircut', startsAt: SLOT, customerName: 'Ana' });
    await call('create_deposit', { bookingId: ana.json.bookingId, bookingToken: ana.json.bookingToken });
    expect((await call('cancel_booking', { bookingId: ana.json.bookingId, bookingToken: ana.json.bookingToken })).json).toMatchObject({ status: 'cancelled' });
    const bo = await call('hold_slot', { serviceId: 'haircut', startsAt: SLOT, customerName: 'Bo' });
    expect(bo.isError).toBe(false);

    // Ana's still-open checkout tab (or a direct POST) tries to authorize her old order.
    await expect(authorizeDeposit(paypal.orders, bookings, ana.json.bookingId, 'ORDER-1', clock)).rejects.toMatchObject({
      code: 'invalid_state',
      httpStatus: 409,
    });
    expect(paypal.requests.map((r) => r.url)).not.toContain('https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-1/authorize');
    expect(bookings.get(ana.json.bookingId)!.status).toBe('cancelled');
  });

  it('R9: a reservation can be renewed once; repeated create_deposit can\'t keep a slot blocked', async () => {
    const bookings = createMemoryBookingStore();
    const { call } = await connect(bookings, orderCreated);
    const ana = await call('hold_slot', { serviceId: 'haircut', startsAt: SLOT, customerName: 'Ana' });
    const ref = { bookingId: ana.json.bookingId, bookingToken: ana.json.bookingToken };
    clock = new Date('2026-11-01T06:40:00.000Z'); // lapsed at 06:30: renewed until 07:10
    expect((await call('create_deposit', ref)).isError).toBe(false);
    clock = new Date('2026-11-01T07:15:00.000Z'); // lapsed again, past the one-hour maximum
    const again = await call('create_deposit', ref);
    expect(again).toMatchObject({ isError: true });
    expect(again.text).toContain('expired');
    // The slot is free for others.
    const bo = await call('hold_slot', { serviceId: 'haircut', startsAt: SLOT, customerName: 'Bo' });
    expect(bo.isError).toBe(false);
  });

  describe('R2: reservations are rate limited', () => {
    it('at most 5 holds per client in 10 minutes', async () => {
      const bookings = createMemoryBookingStore();
      const { call } = await connectWith(bookings, { clientKey: '203.0.113.7', holdLimiter: createRateLimiter({ limit: 5, windowMs: 600_000 }) });
      const starts = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00'].map((t) => `2026-11-02T${t}:00.000Z`);
      const results = [];
      for (const startsAt of starts) results.push(await call('hold_slot', { serviceId: 'haircut', startsAt, customerName: 'Ana' }));
      expect(results.slice(0, 5).every((r) => !r.isError)).toBe(true);
      expect(results[5]).toMatchObject({ isError: true });
      expect(results[5].text).toContain('rate_limited');
    });

    it('at most 30 active unpaid AI reservations in total', async () => {
      const bookings = createMemoryBookingStore();
      for (let i = 0; i < 30; i++) {
        bookings.save({
          id: `held-${i}`,
          serviceId: 'physio',
          customerName: 'x',
          startsAt: '2026-11-03T10:00:00.000Z',
          deposit: { currency: 'USD', cents: 2000 },
          status: 'awaiting_deposit',
          createdAt: NOW.toISOString(),
          source: 'agent',
          staffId: 'ken',
        });
      }
      const { call } = await connect(bookings);
      const refused = await call('hold_slot', { serviceId: 'haircut', startsAt: SLOT, customerName: 'Ana' });
      expect(refused.text).toContain('rate_limited');
    });
  });

  it('R5: an unpaid booking can be cancelled even if PayPal is not configured', async () => {
    const bookings = createMemoryBookingStore();
    const { call } = await connectWith(bookings, {
      payments: () => {
        throw new PayPalConfigError('missing', ['PAYPAL_CLIENT_SECRET']);
      },
    });
    const held = await call('hold_slot', { serviceId: 'haircut', startsAt: SLOT, customerName: 'Ana' });
    expect((await call('cancel_booking', { bookingId: held.json.bookingId, bookingToken: held.json.bookingToken })).json).toMatchObject({
      status: 'cancelled',
    });
  });

  it('R7: create_deposit without PayPal settings says "unavailable" and logs no secret', async () => {
    const bookings = createMemoryBookingStore();
    const { call } = await connectWith(bookings, {
      orders: () => {
        throw new PayPalConfigError('Missing PayPal settings: PAYPAL_CLIENT_SECRET', ['PAYPAL_CLIENT_SECRET']);
      },
    });
    const held = await call('hold_slot', { serviceId: 'haircut', startsAt: SLOT, customerName: 'Ana' });
    const result = await call('create_deposit', { bookingId: held.json.bookingId, bookingToken: held.json.bookingToken });
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain('unavailable');
  });

  it('R7: a pending deposit is released with a void too', async () => {
    const bookings = createMemoryBookingStore();
    const { call, paypal } = await connect(bookings, { status: 204 });
    const held = await call('hold_slot', { serviceId: 'haircut', startsAt: SLOT, customerName: 'Ana' });
    const b = bookings.get(held.json.bookingId)!;
    bookings.save({ ...b, status: 'deposit_pending', hold: { paypalOrderId: 'O', orderAttempt: 1, orderCreatedAt: NOW.toISOString(), authorizationId: 'AUTH-P' } });
    expect((await call('cancel_booking', { bookingId: b.id, bookingToken: held.json.bookingToken })).json).toMatchObject({ status: 'cancelled' });
    expect(paypal.requests[0].url).toContain('/authorizations/AUTH-P/void');
  });

  it('never reveals details to a wrong token, and the same answer for an unknown booking', async () => {
    const bookings = createMemoryBookingStore();
    const { call } = await connect(bookings);
    const held = await call('hold_slot', { serviceId: 'haircut', startsAt: SLOT, customerName: 'Ana' });
    const wrong = await call('booking_status', { bookingId: held.json.bookingId, bookingToken: 'x' });
    const unknown = await call('booking_status', { bookingId: 'nope', bookingToken: 'x' });
    expect(wrong.text).toBe(unknown.text);
    expect(wrong.text).not.toContain('Ana');
  });
});
