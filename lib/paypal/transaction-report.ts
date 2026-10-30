import 'server-only';
import type { TransactionDetails, TransactionSearchController } from '@paypal/paypal-server-sdk';
import type { BookingStore } from '@/lib/booking/store';
import { parseCents } from './deposit-actions';
import { describePayPalError, describeTransportError, isNetworkError, sanitizeError } from './errors';

export type TransactionSearch = Pick<TransactionSearchController, 'searchTransactions'>;

export class ReportError extends Error {
  constructor(
    readonly code: 'invalid_range' | 'search_disabled' | 'paypal_error' | 'network_error' | 'too_many_results',
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'ReportError';
  }
}

/** PayPal Transaction Search answers at most 31 days per request. */
export const MAX_WINDOW_DAYS = 31;
export const MAX_RANGE_DAYS = 366;
const PAGE_SIZE = 500;
const MAX_PAGES_PER_WINDOW = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export const LAG_NOTICE = 'PayPal can take up to 3 hours to show new transactions in Transaction Search, so the last few hours may be missing.';

export type ReportKind = 'deposit_captured' | 'no_show_fee' | 'refund';

export interface ReportRow {
  transactionId: string;
  date: string;
  bookingId: string;
  kind: ReportKind;
  /** Refunds are positive here; they are subtracted in the totals. */
  amountCents: number;
  /** PayPal status: S success, P pending, V reversed (refunded later), D denied. */
  status: string;
}

export interface TransactionReport {
  from: string;
  to: string;
  timeZone: 'UTC';
  windows: Array<{ startDate: string; endDate: string }>;
  rows: ReportRow[];
  totals: {
    depositsCapturedCents: number;
    noShowFeesCents: number;
    refundsCents: number;
    netCents: number;
    counts: Record<ReportKind, number>;
    pendingCount: number;
  };
  /** The oldest "last refreshed" time PayPal reported across the windows. */
  dataRefreshedAt?: string;
  lagNotice: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Splits [from, to] (whole UTC days, inclusive) into windows of at most MAX_WINDOW_DAYS days, the
 * most Transaction Search accepts in one request. The end is clamped to `now` (PayPal refuses future
 * end dates).
 */
export function splitWindows(from: string, to: string, now: Date): Array<{ startDate: string; endDate: string }> {
  if (!DAY.test(from) || !DAY.test(to)) throw new ReportError('invalid_range', 400, 'from and to must look like 2026-10-01.');
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Math.min(Date.parse(`${to}T23:59:59Z`), now.getTime());
  if (Number.isNaN(start) || Number.isNaN(end)) throw new ReportError('invalid_range', 400, 'from and to must be real dates.');
  if (start > end) throw new ReportError('invalid_range', 400, 'from must not be after to (or in the future).');
  if (end - start >= MAX_RANGE_DAYS * DAY_MS) {
    throw new ReportError('invalid_range', 400, `A report covers at most ${MAX_RANGE_DAYS} days.`);
  }
  if (start < now.getTime() - 3 * 365 * DAY_MS) {
    throw new ReportError('invalid_range', 400, 'Transaction Search only covers the last three years.');
  }
  const windows: Array<{ startDate: string; endDate: string }> = [];
  for (let s = start; s <= end; s += MAX_WINDOW_DAYS * DAY_MS) {
    const e = Math.min(s + MAX_WINDOW_DAYS * DAY_MS - 1000, end);
    windows.push({ startDate: new Date(s).toISOString().replace('.000Z', 'Z'), endDate: new Date(e).toISOString().replace('.000Z', 'Z') });
  }
  return windows;
}

async function searchWindow(search: TransactionSearch, window: { startDate: string; endDate: string }) {
  const details: TransactionDetails[] = [];
  let refreshedAt: string | undefined;
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES_PER_WINDOW) {
      throw new ReportError('too_many_results', 422, 'Too many transactions in this range; choose a shorter range.');
    }
    let response;
    try {
      // A read: the shared SDK client already retries GETs once with backoff (lib/paypal/client.ts).
      response = await search.searchTransactions({
        startDate: window.startDate,
        endDate: window.endDate,
        fields: 'transaction_info',
        pageSize: PAGE_SIZE,
        page,
      });
    } catch (err) {
      const failure = describePayPalError(err);
      if (failure) {
        console.error('[report] transaction search failed', { status: failure.status, name: failure.name, issue: failure.issue, debugId: failure.debugId });
        if (failure.status === 403 || failure.name === 'NOT_AUTHORIZED' || failure.name === 'PERMISSION_DENIED') {
          throw new ReportError(
            'search_disabled',
            502,
            'PayPal refused Transaction Search. Turn on "Transaction search" for this app in developer.paypal.com (Apps & Credentials > app > Features), then wait up to 10 minutes.',
          );
        }
        if (failure.status < 500) {
          throw new ReportError('paypal_error', 422, `PayPal could not search this range (${failure.issue ?? failure.name ?? `HTTP ${failure.status}`}).`);
        }
        throw new ReportError('paypal_error', 502, 'PayPal Transaction Search is unavailable; please try again.');
      }
      if (isNetworkError(err)) {
        console.error('[report] could not reach PayPal', { reason: describeTransportError(err) });
        throw new ReportError('network_error', 502, 'Could not reach PayPal; please try again.');
      }
      throw sanitizeError(err, 'Transaction search');
    }
    const result = response.result;
    // Known from the first page: don't fetch 20 pages only to give up.
    if ((result.totalPages ?? 0) > MAX_PAGES_PER_WINDOW) {
      throw new ReportError('too_many_results', 422, 'Too many transactions in this range; choose a shorter range.');
    }
    details.push(...(result.transactionDetails ?? []));
    refreshedAt = result.lastRefreshedDatetime ?? refreshedAt;
    if (!result.totalPages || page >= result.totalPages) break;
  }
  return { details, refreshedAt };
}

/** SlotKeeper's own transactions carry our invoice ids: `<booking>-capture-…`, `-refund-…`, `-wallet-…`. */
const INVOICE = /^(.+)-(capture|refund|wallet)-\d/;

function classify(detail: TransactionDetails, store: BookingStore): ReportRow | undefined {
  const info = detail.transactionInfo;
  const match = info?.invoiceId ? INVOICE.exec(info.invoiceId) : null;
  if (!info?.transactionId || !match) return undefined;
  const value = info.transactionAmount?.value ?? '';
  const negative = value.startsWith('-');
  const cents = parseCents(value.replace(/^-/, ''));
  if (cents === undefined) return undefined;
  const bookingId = info.customField || match[1];
  let kind: ReportKind;
  // Money going back out (a refund, or a reversal carrying the original invoice id) is never income.
  if (match[2] === 'refund' || negative) kind = 'refund';
  else if (match[2] === 'wallet') kind = 'no_show_fee'; // the saved wallet is only charged after a no-show
  else {
    // Prefer what we recorded; bookings are in memory, so fall back to the note sent to the customer.
    const recorded = store.get(bookingId)?.hold?.capture;
    const reason = recorded?.captureId === info.transactionId ? recorded.reason : undefined;
    const noted = /no-show/i.test(`${info.transactionNote ?? ''} ${info.transactionSubject ?? ''}`);
    kind = reason === 'no_show' || (reason === undefined && noted) ? 'no_show_fee' : 'deposit_captured';
  }
  return {
    transactionId: info.transactionId,
    date: info.transactionInitiationDate ?? '',
    bookingId,
    kind,
    amountCents: cents,
    status: info.transactionStatus ?? '',
  };
}

/**
 * Captured deposits, no-show fees and refunds for a date range, from PayPal Transaction Search:
 * the range is split into 31-day windows and every page of each window is read.
 */
export async function buildTransactionReport(
  search: TransactionSearch,
  store: BookingStore,
  range: { from: string; to: string },
  now: Date = new Date(),
): Promise<TransactionReport> {
  const windows = splitWindows(range.from, range.to, now);
  const rows = new Map<string, ReportRow>();
  let dataRefreshedAt: string | undefined;
  for (const window of windows) {
    const { details, refreshedAt } = await searchWindow(search, window);
    if (refreshedAt && (!dataRefreshedAt || refreshedAt < dataRefreshedAt)) dataRefreshedAt = refreshedAt;
    for (const detail of details) {
      const row = classify(detail, store);
      if (row) rows.set(row.transactionId, row);
    }
  }

  const sorted = [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
  // Status is the transaction's current state: a capture that was later refunded in full reads "V"
  // (reversed). The money was still captured and its refund row takes it back out, so V counts
  // for captures; refunds count when completed (S). Pending (P) and denied (D) are left out.
  const settled = sorted.filter((r) => r.status === 'S' || (r.status === 'V' && r.kind !== 'refund'));
  const sum = (kind: ReportKind) => settled.filter((r) => r.kind === kind).reduce((total, r) => total + r.amountCents, 0);
  const deposits = sum('deposit_captured');
  const fees = sum('no_show_fee');
  const refunds = sum('refund');
  return {
    from: range.from,
    to: range.to,
    timeZone: 'UTC',
    windows,
    rows: sorted,
    totals: {
      depositsCapturedCents: deposits,
      noShowFeesCents: fees,
      refundsCents: refunds,
      netCents: deposits + fees - refunds,
      counts: {
        deposit_captured: settled.filter((r) => r.kind === 'deposit_captured').length,
        no_show_fee: settled.filter((r) => r.kind === 'no_show_fee').length,
        refund: settled.filter((r) => r.kind === 'refund').length,
      },
      pendingCount: sorted.filter((r) => r.status === 'P').length,
    },
    dataRefreshedAt,
    lagNotice: LAG_NOTICE,
  };
}
