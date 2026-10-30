import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryBookingStore, type Booking } from '@/lib/booking/store';
import { buildTransactionReport, LAG_NOTICE, splitWindows } from '@/lib/paypal/transaction-report';
import { networkDrop, stubPayPal, type Reply } from '../helpers/paypal-stub';

// Fixed clock: tests never depend on the real date.
const NOW = new Date('2026-11-01T12:00:00.000Z');

function search(...replies: Reply[]) {
  const paypal = stubPayPal(...replies);
  return { paypal, controller: paypal.transactionSearch };
}

const tx = (id: string, invoice: string | undefined, value: string, extra: Record<string, unknown> = {}) => ({
  transaction_info: {
    transaction_id: id,
    transaction_initiation_date: '2026-10-20T10:00:00+0000',
    transaction_amount: { currency_code: 'USD', value },
    transaction_status: 'S',
    invoice_id: invoice,
    custom_field: invoice?.split('-capture-')[0].split('-refund-')[0].split('-wallet-')[0],
    ...extra,
  },
});

const page = (details: unknown[], pageNo = 1, totalPages = 1): Reply => ({
  status: 200,
  body: { transaction_details: details, page: pageNo, total_pages: totalPages, total_items: details.length, last_refreshed_datetime: '2026-11-01T09:00:00+0000' },
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('splitWindows', () => {
  it('splits a range into windows of at most 31 days, ending at the range end', () => {
    expect(splitWindows('2026-08-01', '2026-10-31', NOW)).toEqual([
      { startDate: '2026-08-01T00:00:00Z', endDate: '2026-08-31T23:59:59Z' },
      { startDate: '2026-09-01T00:00:00Z', endDate: '2026-10-01T23:59:59Z' },
      { startDate: '2026-10-02T00:00:00Z', endDate: '2026-10-31T23:59:59Z' },
    ]);
  });

  it('clamps the end to now and keeps a single day as one window', () => {
    expect(splitWindows('2026-11-01', '2026-11-05', NOW)).toEqual([{ startDate: '2026-11-01T00:00:00Z', endDate: '2026-11-01T12:00:00Z' }]);
  });

  it.each([
    ['2026-10-10', '2026-10-01', 'after'],
    ['2026-1-1', '2026-10-01', 'look like'],
    ['2025-01-01', '2026-10-31', 'at most 366'],
    ['2023-01-01', '2023-01-31', 'three years'],
    ['2026-12-01', '2026-12-05', 'after'],
  ])('rejects %s..%s', (from, to, message) => {
    expect(() => splitWindows(from, to, NOW)).toThrow(message);
  });
});

describe('buildTransactionReport', () => {
  it('reads every page of every window and classifies SlotKeeper transactions', async () => {
    const store = createMemoryBookingStore();
    const b: Booking = {
      id: 'bk-1',
      serviceId: 'haircut',
      customerName: 'Ana',
      startsAt: '2026-10-20T10:00:00.000Z',
      deposit: { currency: 'USD', cents: 1000 },
      status: 'no_show_charged',
      createdAt: '2026-10-19T10:00:00.000Z',
      hold: {
        paypalOrderId: 'O',
        orderAttempt: 1,
        orderCreatedAt: '2026-10-19T10:00:00.000Z',
        capture: { captureId: 'CAP-NS', amountCents: 400, status: 'COMPLETED', reason: 'no_show', capturedAt: '2026-10-20T10:00:00.000Z' },
      },
    };
    store.save(b);
    const { paypal, controller } = search(
      // Window 1 (Sep 15 – Oct 15): two pages.
      page([tx('CAP-1', 'bk-2-capture-1', '10.00'), tx('OTHER', undefined, '99.00')], 1, 2),
      page([tx('REF-1', 'bk-2-refund-1-1', '-2.50')], 2, 2),
      // Window 2 (Oct 16 – Oct 31): one page.
      page([
        tx('CAP-NS', 'bk-1-capture-1', '4.00'),
        tx('W-1', 'bk-1-wallet-1-1', '6.00'),
        tx('CAP-3', 'gone-capture-1', '20.00', { transaction_note: 'No-show fee for your missed appointment.' }),
        tx('CAP-P', 'bk-4-capture-1', '30.00', { transaction_status: 'P' }),
      ]),
    );

    const report = await buildTransactionReport(controller, store, { from: '2026-09-15', to: '2026-10-31' }, NOW);

    expect(paypal.requests.map((r) => r.url.split('?')[1])).toEqual([
      expect.stringContaining('page=1'),
      expect.stringContaining('page=2'),
      expect.stringContaining('page=1'),
    ]);
    expect(paypal.requests[0].url).toContain('/v1/reporting/transactions');
    expect(paypal.requests[0].url).toContain('start_date=2026-09-15T00%3A00%3A00Z');
    expect(paypal.requests[0].url).toContain('page_size=500');
    expect(paypal.requests[0].url).toContain('fields=transaction_info');

    expect(report.rows.map((r) => [r.transactionId, r.kind, r.amountCents, r.bookingId])).toEqual([
      ['CAP-1', 'deposit_captured', 1000, 'bk-2'],
      ['REF-1', 'refund', 250, 'bk-2'],
      ['CAP-NS', 'no_show_fee', 400, 'bk-1'],
      ['W-1', 'no_show_fee', 600, 'bk-1'],
      ['CAP-3', 'no_show_fee', 2000, 'gone'],
      ['CAP-P', 'deposit_captured', 3000, 'bk-4'],
    ]);
    expect(report.totals).toEqual({
      depositsCapturedCents: 1000,
      noShowFeesCents: 3000,
      refundsCents: 250,
      netCents: 3750,
      counts: { deposit_captured: 1, no_show_fee: 3, refund: 1 },
      pendingCount: 1,
    });
    expect(report.lagNotice).toBe(LAG_NOTICE);
    expect(report.dataRefreshedAt).toBeDefined();
  });

  it('R1: a capture refunded in full (status V) still counts, so capture + refund nets to zero', async () => {
    const { controller } = search(
      page([
        tx('CAP-V', 'bk-7-capture-1', '10.00', { transaction_status: 'V' }),
        tx('REF-V', 'bk-7-refund-1-1', '-10.00'),
        tx('CAP-V2', 'bk-8-capture-1', '20.00', { transaction_status: 'V' }), // refunded after the range
        tx('CAP-D', 'bk-9-capture-1', '30.00', { transaction_status: 'D' }), // denied: never money
      ]),
    );
    const report = await buildTransactionReport(controller, createMemoryBookingStore(), { from: '2026-10-01', to: '2026-10-31' }, NOW);
    expect(report.totals).toMatchObject({ depositsCapturedCents: 3000, refundsCents: 1000, netCents: 2000 });
  });

  it('R2: a negative amount under a capture or wallet invoice is money out, never income', async () => {
    const { controller } = search(
      page([tx('CAP-1', 'bk-1-capture-1', '10.00'), tx('REV-1', 'bk-1-capture-1', '-10.00'), tx('REV-2', 'bk-1-wallet-1-1', '-6.00')]),
    );
    const report = await buildTransactionReport(controller, createMemoryBookingStore(), { from: '2026-10-01', to: '2026-10-31' }, NOW);
    expect(report.rows.map((r) => [r.transactionId, r.kind])).toEqual([
      ['CAP-1', 'deposit_captured'],
      ['REV-1', 'refund'],
      ['REV-2', 'refund'],
    ]);
    expect(report.totals).toMatchObject({ depositsCapturedCents: 1000, noShowFeesCents: 0, refundsCents: 1600, netCents: -600 });
  });

  it('R3: a transaction seen on two pages is counted once', async () => {
    const { controller } = search(page([tx('CAP-1', 'bk-1-capture-1', '10.00')], 1, 2), page([tx('CAP-1', 'bk-1-capture-1', '10.00')], 2, 2));
    const report = await buildTransactionReport(controller, createMemoryBookingStore(), { from: '2026-10-01', to: '2026-10-31' }, NOW);
    expect(report.rows).toHaveLength(1);
    expect(report.totals.depositsCapturedCents).toBe(1000);
  });

  it('R3/R4: refuses at once when the first page says there are too many pages', async () => {
    const { controller, paypal } = search(page([], 1, 21));
    await expect(
      buildTransactionReport(controller, createMemoryBookingStore(), { from: '2026-10-01', to: '2026-10-31' }, NOW),
    ).rejects.toMatchObject({ code: 'too_many_results', httpStatus: 422 });
    expect(paypal.requests).toHaveLength(1);
  });

  it('R3: maps PayPal 4xx to 422 and 5xx to 502', async () => {
    const range = { from: '2026-10-01', to: '2026-10-31' };
    await expect(
      buildTransactionReport(search({ status: 400, body: { name: 'INVALID_REQUEST', details: [{ issue: 'INVALID_DATE' }] } }).controller, createMemoryBookingStore(), range, NOW),
    ).rejects.toMatchObject({ code: 'paypal_error', httpStatus: 422, message: expect.stringContaining('INVALID_DATE') });
    await expect(
      buildTransactionReport(search({ status: 503, body: { name: 'SERVICE_UNAVAILABLE' } }).controller, createMemoryBookingStore(), range, NOW),
    ).rejects.toMatchObject({ code: 'paypal_error', httpStatus: 502 });
  });

  it('R3: an unexpected error is re-thrown with only its name and first line (no credentials)', async () => {
    const leaky = {
      searchTransactions: async () => {
        throw new TypeError('boom\nAuthorization: Basic dGVzdC1zZWNyZXQ=');
      },
    };
    const err = await buildTransactionReport(leaky as never, createMemoryBookingStore(), { from: '2026-10-01', to: '2026-10-31' }, NOW).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err!.message).toBe('Transaction search: TypeError: boom');
    expect(JSON.stringify([err!.message, err!.stack, vi.mocked(console.error).mock.calls])).not.toContain('dGVzdC1zZWNyZXQ=');
  });

  it('explains how to enable Transaction Search when PayPal refuses it', async () => {
    const { controller } = search({ status: 403, body: { name: 'NOT_AUTHORIZED', message: 'no', debug_id: 'dbg' } });
    await expect(
      buildTransactionReport(controller, createMemoryBookingStore(), { from: '2026-10-01', to: '2026-10-31' }, NOW),
    ).rejects.toMatchObject({ code: 'search_disabled', message: expect.stringContaining('Transaction search') });
  });

  it('maps a network failure to a retryable error', async () => {
    const { controller } = search(networkDrop());
    await expect(
      buildTransactionReport(controller, createMemoryBookingStore(), { from: '2026-10-01', to: '2026-10-31' }, NOW),
    ).rejects.toMatchObject({ code: 'network_error', httpStatus: 502 });
  });
});
