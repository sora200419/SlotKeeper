import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BookingBusyError } from '@/lib/booking/locks';
import { createMemoryBookingStore, type Booking, type BookingStore } from '@/lib/booking/store';
import {
  createMemoryPayoutStore,
  payoutOutcome,
  refreshPayouts,
  runDailyPayouts,
  type PayoutDeps,
} from '@/lib/paypal/payouts';
import { PayPalRestError, PayPalUnreachableError, type RestRequest, type RestTransport } from '@/lib/paypal/rest';

// Fixed clock: tests never depend on the real date.
// The morning after DAY (UTC): DAY is over, so it can be paid.
const NOW = new Date('2026-11-02T01:00:00.000Z');
const DAY = '2026-11-01';

type Reply = unknown | Error | (() => Promise<unknown>);

function fakeRest(...replies: Reply[]) {
  const calls: RestRequest[] = [];
  const rest: RestTransport = {
    async request<T>(request: RestRequest): Promise<T> {
      calls.push(structuredClone(request));
      const reply = replies.shift();
      if (reply === undefined) throw new Error('Unexpected PayPal request in test');
      if (reply instanceof Error) throw reply;
      if (typeof reply === 'function') return (await (reply as () => Promise<unknown>)()) as T;
      return reply as T;
    },
  };
  return { rest, calls };
}

function capturedBooking(store: BookingStore, id: string, serviceId: string, amountCents: number, extra: Partial<Booking> = {}) {
  store.save({
    id,
    serviceId,
    customerName: 'Ana',
    startsAt: `${DAY}T10:00:00.000Z`,
    deposit: { currency: 'USD', cents: 1000 },
    status: 'completed',
    createdAt: '2026-10-31T10:00:00.000Z',
    hold: {
      paypalOrderId: 'O',
      orderAttempt: 1,
      orderCreatedAt: '2026-10-31T10:00:00.000Z',
      capture: { captureId: `CAP-${id}`, amountCents, status: 'COMPLETED', reason: 'completed', capturedAt: `${DAY}T12:00:00.000Z` },
    },
    ...extra,
  });
}

function deps(rest: RestTransport, bookings: BookingStore, emails: Record<string, string> = { maria: 'maria@personal.example.com', ken: 'ken@personal.example.com' }): PayoutDeps {
  return { rest, bookings, payouts: createMemoryPayoutStore(), emails: new Map(Object.entries(emails)), timeZone: 'UTC' };
}

const accepted = { batch_header: { payout_batch_id: 'BATCH-1', batch_status: 'PENDING' } };
const rejected = (status: number, name: string, issue?: string) =>
  new PayPalRestError({ status, name, issue, debugId: 'dbg-1' });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('runDailyPayouts', () => {
  it('sends one EMAIL batch per day with each staff member\'s commission and tips', async () => {
    const bookings = createMemoryBookingStore();
    capturedBooking(bookings, 'b1', 'haircut', 1000, { tipCents: 500 }); // Maria: 400 + 500
    capturedBooking(bookings, 'b2', 'physio', 2000); // Ken: 1000
    const { rest, calls } = fakeRest(accepted);

    const record = await runDailyPayouts(deps(rest, bookings), DAY, NOW);

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        requestId: 'slotkeeper-payouts-2026-11-01-1',
        body: {
          sender_batch_header: {
            sender_batch_id: 'slotkeeper-payouts-2026-11-01',
            recipient_type: 'EMAIL',
            email_subject: 'Your SlotKeeper earnings',
            email_message: 'Your commission and tips for 2026-11-01. Thank you!',
          },
          items: [
            {
              recipient_type: 'EMAIL',
              receiver: 'ken@personal.example.com',
              amount: { currency: 'USD', value: '10.00' },
              note: 'Ken: commission 10.00 + tips 0.00 for 2026-11-01',
              sender_item_id: '2026-11-01-ken',
              recipient_wallet: 'PAYPAL',
            },
            {
              recipient_type: 'EMAIL',
              receiver: 'maria@personal.example.com',
              amount: { currency: 'USD', value: '9.00' },
              note: 'Maria: commission 4.00 + tips 5.00 for 2026-11-01',
              sender_item_id: '2026-11-01-maria',
              recipient_wallet: 'PAYPAL',
            },
          ],
        },
      },
    ]);
    expect(record).toMatchObject({ state: 'submitted', payoutBatchId: 'BATCH-1', batchStatus: 'PENDING', skipped: [] });
  });

  it('leaves out staff with no payout email or nothing to pay, and sends nothing if no one is left', async () => {
    const bookings = createMemoryBookingStore();
    capturedBooking(bookings, 'b1', 'haircut', 1000);
    const { rest, calls } = fakeRest();
    const record = await runDailyPayouts(deps(rest, bookings, { ken: 'ken@personal.example.com' }), DAY, NOW);
    expect(calls).toHaveLength(0);
    expect(record).toMatchObject({
      state: 'nothing_to_pay',
      items: [],
      skipped: [{ staffId: 'maria', reason: 'no_payout_email', totalCents: 400 }],
    });
  });

  it('running again after the batch was sent only refreshes item statuses (never pays twice)', async () => {
    const bookings = createMemoryBookingStore();
    capturedBooking(bookings, 'b1', 'haircut', 1000);
    capturedBooking(bookings, 'b2', 'physio', 2000);
    const { rest, calls } = fakeRest(accepted, {
      batch_header: { payout_batch_id: 'BATCH-1', batch_status: 'SUCCESS' },
      items: [
        { payout_item_id: 'I-1', transaction_status: 'SUCCESS', payout_item: { sender_item_id: '2026-11-01-maria' } },
        { payout_item_id: 'I-2', transaction_status: 'UNCLAIMED', payout_item: { sender_item_id: '2026-11-01-ken' }, errors: { name: 'RECEIVER_UNREGISTERED' } },
      ],
    });
    const d = deps(rest, bookings);
    await runDailyPayouts(d, DAY, NOW);
    const again = await runDailyPayouts(d, DAY, NOW);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/payments/payouts',
      'GET /v1/payments/payouts/BATCH-1?page=1&page_size=100&total_required=true',
    ]);
    expect(again.batchStatus).toBe('SUCCESS');
    expect(again.items.map((i) => [i.staffId, i.transactionStatus, i.outcome, i.error])).toEqual([
      ['ken', 'UNCLAIMED', 'unclaimed', 'RECEIVER_UNREGISTERED'],
      ['maria', 'SUCCESS', 'paid', undefined],
    ]);
  });

  it('after an unknown outcome, replays the same request with the same frozen amounts', async () => {
    const bookings = createMemoryBookingStore();
    capturedBooking(bookings, 'b1', 'haircut', 1000);
    const { rest, calls } = fakeRest(new PayPalUnreachableError('socket hang up'), accepted);
    const d = deps(rest, bookings);

    await expect(runDailyPayouts(d, DAY, NOW)).rejects.toMatchObject({ code: 'network_error', httpStatus: 502 });
    expect(d.payouts.get(DAY)!.state).toBe('submitting');

    // More money came in meanwhile; the replay must not change what was (maybe) already sent.
    capturedBooking(bookings, 'b2', 'color', 3000);
    const record = await runDailyPayouts(d, DAY, NOW);

    expect(calls[1].requestId).toBe(calls[0].requestId);
    expect(calls[1].body).toEqual(calls[0].body);
    expect(record.state).toBe('submitted');
  });

  it('a 5xx is also an unknown outcome and is replayed with the same id', async () => {
    const bookings = createMemoryBookingStore();
    capturedBooking(bookings, 'b1', 'haircut', 1000);
    const { rest, calls } = fakeRest(rejected(500, 'INTERNAL_SERVER_ERROR'), accepted);
    const d = deps(rest, bookings);
    await expect(runDailyPayouts(d, DAY, NOW)).rejects.toMatchObject({ code: 'paypal_error' });
    await runDailyPayouts(d, DAY, NOW);
    expect(calls[1].requestId).toBe('slotkeeper-payouts-2026-11-01-1');
  });

  it('a definite rejection pays nothing; the next run recomputes with a new request id', async () => {
    const bookings = createMemoryBookingStore();
    capturedBooking(bookings, 'b1', 'haircut', 1000);
    const { rest, calls } = fakeRest(rejected(422, 'INSUFFICIENT_FUNDS'), accepted);
    const d = deps(rest, bookings);

    await expect(runDailyPayouts(d, DAY, NOW)).rejects.toMatchObject({
      code: 'paypal_rejected',
      httpStatus: 422,
      paypal: { name: 'INSUFFICIENT_FUNDS' },
    });
    expect(d.payouts.get(DAY)).toMatchObject({ state: 'rejected', lastError: { name: 'INSUFFICIENT_FUNDS' } });

    await runDailyPayouts(d, DAY, NOW);
    expect(calls.map((c) => c.requestId)).toEqual([
      'slotkeeper-payouts-2026-11-01-1',
      'slotkeeper-payouts-2026-11-01-2',
    ]);
  });

  // The exact duplicate answer is not confirmed against sandbox yet; both a name and a description
  // style are recognised.
  it.each([
    [rejected(400, 'USER_BUSINESS_ERROR', 'DUPLICATE_SENDER_BATCH_ID')],
    [new PayPalRestError({ status: 400, name: 'USER_BUSINESS_ERROR', issue: 'Batch with given sender_batch_id already exists' })],
  ])('a duplicate batch id goes to review and is never resent (%#)', async (answer) => {
    const bookings = createMemoryBookingStore();
    capturedBooking(bookings, 'b1', 'haircut', 1000);
    const { rest, calls } = fakeRest(answer);
    const d = deps(rest, bookings);
    await expect(runDailyPayouts(d, DAY, NOW)).rejects.toMatchObject({ code: 'needs_review', httpStatus: 409 });
    expect((await runDailyPayouts(d, DAY, NOW)).state).toBe('needs_review');
    expect(calls).toHaveLength(1);
  });

  it('R2: any 4xx after an unknown outcome goes to review, not "rejected" (the batch may be paid)', async () => {
    const bookings = createMemoryBookingStore();
    capturedBooking(bookings, 'b1', 'haircut', 1000);
    const { rest, calls } = fakeRest(new PayPalUnreachableError('socket hang up'), rejected(400, 'VALIDATION_ERROR'));
    const d = deps(rest, bookings);
    await expect(runDailyPayouts(d, DAY, NOW)).rejects.toMatchObject({ code: 'network_error' });
    await expect(runDailyPayouts(d, DAY, NOW)).rejects.toMatchObject({ code: 'needs_review' });
    expect(d.payouts.get(DAY)!.state).toBe('needs_review');
    expect((await runDailyPayouts(d, DAY, NOW)).state).toBe('needs_review');
    expect(calls).toHaveLength(2);
  });

  it('R1: refuses today and future days in the business time zone, without sending or storing anything', async () => {
    const bookings = createMemoryBookingStore();
    capturedBooking(bookings, 'b1', 'haircut', 1000);
    const { rest, calls } = fakeRest();
    const d = deps(rest, bookings);
    for (const day of ['2026-11-02', '2026-11-05']) {
      await expect(runDailyPayouts(d, day, NOW)).rejects.toMatchObject({ code: 'day_not_over', httpStatus: 409 });
      expect(d.payouts.get(day)).toBeUndefined();
    }
    // In Los Angeles it is still 2026-11-01 at NOW (01:00 UTC on the 2nd), so DAY is not over there.
    await expect(runDailyPayouts({ ...d, timeZone: 'America/Los_Angeles' }, DAY, NOW)).rejects.toMatchObject({
      code: 'day_not_over',
    });
    expect(calls).toHaveLength(0);
  });

  it('R9: a day can be paid only after a grace period, so money still being saved for it is counted', async () => {
    const bookings = createMemoryBookingStore();
    const { rest, calls } = fakeRest(accepted);
    const d = deps(rest, bookings);

    // 00:05 on the next day: a capture stamped 23:59:58 on DAY may still be waiting on PayPal.
    await expect(runDailyPayouts(d, DAY, new Date('2026-11-02T00:05:00.000Z'))).rejects.toMatchObject({
      code: 'day_not_over',
    });
    expect(d.payouts.get(DAY)).toBeUndefined();

    // That capture is saved at 00:00:03 with its start time on DAY ...
    bookings.save({
      id: 'late',
      serviceId: 'haircut',
      customerName: 'Ana',
      startsAt: `${DAY}T23:00:00.000Z`,
      deposit: { currency: 'USD', cents: 1000 },
      status: 'completed',
      createdAt: `${DAY}T10:00:00.000Z`,
      hold: {
        paypalOrderId: 'O',
        orderAttempt: 1,
        orderCreatedAt: `${DAY}T10:00:00.000Z`,
        capture: { captureId: 'CAP-L', amountCents: 1000, status: 'COMPLETED', reason: 'completed', capturedAt: `${DAY}T23:59:58.000Z` },
      },
    });
    // ... and the payout after the grace period includes it.
    await runDailyPayouts(d, DAY, new Date('2026-11-02T00:20:00.000Z'));
    expect(calls[0].body).toMatchObject({ items: [{ sender_item_id: '2026-11-01-maria', amount: { value: '4.00' } }] });
  });

  it('R5: refuses to rerun a day with a different time zone', async () => {
    const bookings = createMemoryBookingStore();
    capturedBooking(bookings, 'b1', 'haircut', 1000);
    const { rest } = fakeRest(accepted);
    const d = deps(rest, bookings);
    await runDailyPayouts(d, DAY, NOW);
    await expect(
      runDailyPayouts({ ...d, timeZone: 'Asia/Kuala_Lumpur' }, DAY, new Date('2026-11-03T01:00:00.000Z')),
    ).rejects.toMatchObject({ code: 'time_zone_changed', httpStatus: 409 });
  });

  it('R3: a token failure is an unknown-outcome network error that never leaks the credentials', async () => {
    const { createRestTransport } = await import('@/lib/paypal/rest');
    const bookings = createMemoryBookingStore();
    capturedBooking(bookings, 'b1', 'haircut', 1000);
    const leaky = Object.assign(new Error('Request failed\nAuthorization: Basic c2VjcmV0OnNlY3JldA=='), {
      config: { headers: { Authorization: 'Basic c2VjcmV0OnNlY3JldA==' } },
    });
    const rest = createRestTransport({
      baseUrl: 'https://api-m.sandbox.paypal.com',
      getToken: async () => {
        throw leaky;
      },
      timeoutMs: 1000,
      fetchFn: (async () => {
        throw new Error('fetch must not be called');
      }) as unknown as typeof fetch,
    });
    const d = deps(rest, bookings);
    const err = await runDailyPayouts(d, DAY, NOW).then(() => undefined, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'network_error', httpStatus: 502 });
    expect(d.payouts.get(DAY)!.state).toBe('submitting');
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    for (const text of [String((err as Error).message), (err as Error).stack ?? '', JSON.stringify(err), logged]) {
      expect(text).not.toContain('c2VjcmV0OnNlY3JldA==');
    }
  });

  it('R8: reads every page of a large batch', async () => {
    const bookings = createMemoryBookingStore();
    capturedBooking(bookings, 'b1', 'haircut', 1000);
    const filler = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ transaction_status: 'SUCCESS', payout_item: { sender_item_id: `other-${i}` } }));
    const { rest, calls } = fakeRest(
      accepted,
      { batch_header: { batch_status: 'SUCCESS' }, total_items: 101, items: filler(100) },
      {
        batch_header: { batch_status: 'SUCCESS' },
        total_items: 101,
        items: [{ payout_item_id: 'I-M', transaction_status: 'SUCCESS', payout_item: { sender_item_id: '2026-11-01-maria' } }],
      },
    );
    const d = deps(rest, bookings);
    await runDailyPayouts(d, DAY, NOW);
    const refreshed = await refreshPayouts(d, DAY, NOW);
    expect(calls.slice(1).map((c) => c.path)).toEqual([
      '/v1/payments/payouts/BATCH-1?page=1&page_size=100&total_required=true',
      '/v1/payments/payouts/BATCH-1?page=2&page_size=100&total_required=true',
    ]);
    expect(refreshed.items).toMatchObject([{ staffId: 'maria', outcome: 'paid' }]);
  });

  it('two runs for the same day at once: the second is refused', async () => {
    const bookings = createMemoryBookingStore();
    capturedBooking(bookings, 'b1', 'haircut', 1000);
    let release!: () => void;
    const { rest, calls } = fakeRest(() => new Promise((resolve) => (release = () => resolve(accepted))));
    const d = deps(rest, bookings);
    const first = runDailyPayouts(d, DAY, NOW);
    await expect(runDailyPayouts(d, DAY, NOW)).rejects.toBeInstanceOf(BookingBusyError);
    release();
    await first;
    expect(calls).toHaveLength(1);
  });

  it('rejects a malformed day', async () => {
    const { rest } = fakeRest();
    await expect(runDailyPayouts(deps(rest, createMemoryBookingStore()), '2026-13-45x', NOW)).rejects.toMatchObject({
      code: 'invalid_date',
    });
  });
});

describe('refreshPayouts', () => {
  it('is a 404 for a day without a batch and makes no PayPal call before submission', async () => {
    const { rest, calls } = fakeRest();
    const d = deps(rest, createMemoryBookingStore());
    await expect(refreshPayouts(d, DAY, NOW)).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
    await runDailyPayouts(d, DAY, NOW); // nothing to pay
    expect((await refreshPayouts(d, DAY, NOW)).state).toBe('nothing_to_pay');
    expect(calls).toHaveLength(0);
  });
});

describe('payoutOutcome', () => {
  it.each([
    ['SUCCESS', 'paid'],
    ['PENDING', 'in_progress'],
    ['ONHOLD', 'in_progress'],
    ['UNCLAIMED', 'unclaimed'],
    ['FAILED', 'failed'],
    ['RETURNED', 'failed'],
    ['BLOCKED', 'failed'],
    ['REFUNDED', 'failed'],
    ['REVERSED', 'failed'],
    ['SOMETHING_NEW', 'unknown'],
    [undefined, 'unknown'],
  ])('%s → %s', (status, outcome) => {
    expect(payoutOutcome(status)).toBe(outcome);
  });
});
