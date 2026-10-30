import 'server-only';
import { formatAmount } from '@/lib/booking/catalog';
import { businessDay, dailyEarnings } from '@/lib/booking/earnings';
import { withBookingLock } from '@/lib/booking/locks';
import { findStaff } from '@/lib/booking/staff';
import type { BookingStore } from '@/lib/booking/store';
import { loadedRecords, persist, registerStore } from '@/lib/storage/records';
import { isDefiniteRefusal, type PayPalFailure } from './errors';
import { PayPalRestError, PayPalUnreachableError, type RestTransport } from './rest';

export class PayoutError extends Error {
  constructor(
    readonly code:
      | 'invalid_date'
      | 'day_not_over'
      | 'time_zone_changed'
      | 'not_found'
      | 'paypal_rejected'
      | 'paypal_error'
      | 'network_error'
      | 'needs_review',
    readonly httpStatus: number,
    message: string,
    readonly paypal?: PayPalFailure,
  ) {
    super(message);
    this.name = 'PayoutError';
  }
}

/** What staff should do about one payout item, derived from PayPal's transaction_status. */
export type PayoutOutcome = 'paid' | 'in_progress' | 'unclaimed' | 'failed' | 'unknown';

export interface PayoutItemRecord {
  staffId: string;
  receiver: string;
  amountCents: number;
  commissionCents: number;
  tipCents: number;
  /** `<day>-<staffId>`: PayPal echoes it back so items can be matched. */
  senderItemId: string;
  payoutItemId?: string;
  /** PayPal transaction_status: SUCCESS, PENDING, UNCLAIMED, FAILED, RETURNED, ONHOLD, BLOCKED, ... */
  transactionStatus?: string;
  outcome: PayoutOutcome;
  /** PayPal's error name for a failed item, e.g. RECEIVER_UNREGISTERED. */
  error?: string;
}

export type PayoutBatchState =
  /** No staff earned anything payable; nothing was sent. */
  | 'nothing_to_pay'
  /** Sent, but PayPal's answer was never seen; the next run replays the same request. */
  | 'submitting'
  /** PayPal accepted the batch (see batchStatus and the items). */
  | 'submitted'
  /** PayPal refused the request (definite 4xx); nothing was paid. The next run may try again. */
  | 'rejected'
  /** PayPal says this batch id already exists but we don't know its payout id: check the dashboard. */
  | 'needs_review';

export interface PayoutBatchRecord {
  day: string;
  /** The time zone the day was computed in; a later run with another zone could pay money twice. */
  timeZone: string;
  senderBatchId: string;
  /** Set once a send's outcome was unknown: from then on PayPal may hold this batch already. */
  outcomeUnknownSince?: string;
  /** Part of the PayPal-Request-Id; bumped only after a definite rejection. */
  attempt: number;
  state: PayoutBatchState;
  payoutBatchId?: string;
  /** PayPal batch_status: PENDING, PROCESSING, SUCCESS, DENIED, CANCELED. */
  batchStatus?: string;
  items: PayoutItemRecord[];
  /** Staff left out of the batch and why. */
  skipped: Array<{ staffId: string; reason: 'no_payout_email' | 'nothing_to_pay'; totalCents: number }>;
  lastError?: PayPalFailure;
  createdAt: string;
  updatedAt: string;
}

export interface PayoutStore {
  get(day: string): PayoutBatchRecord | undefined;
  save(record: PayoutBatchRecord): void;
  findByPayoutBatchId(payoutBatchId: string): PayoutBatchRecord | undefined;
}

export function createMemoryPayoutStore(): PayoutStore {
  const records = new Map<string, PayoutBatchRecord>();
  return {
    get: (day) => structuredClone(records.get(day)),
    save: (record) => void records.set(record.day, structuredClone(record)),
    findByPayoutBatchId: (id) => structuredClone([...records.values()].find((r) => r.payoutBatchId === id)),
  };
}

const globalPayouts = globalThis as typeof globalThis & { __slotkeeperPayouts?: PayoutStore };

export function getPayoutStore(): PayoutStore {
  if (!globalPayouts.__slotkeeperPayouts) {
    const memory = createMemoryPayoutStore();
    for (const record of loadedRecords<PayoutBatchRecord>('payout')) memory.save(record);
    const persisted: PayoutStore = {
      ...memory,
      save: (record) => {
        memory.save(record);
        persist('payout', record.day, record);
      },
    };
    registerStore('payout', {
      apply: (data) => memory.save(data as PayoutBatchRecord),
      onConflict: (data) => persisted.save({ ...(data as PayoutBatchRecord), state: 'needs_review' }),
    });
    globalPayouts.__slotkeeperPayouts = persisted;
  }
  return globalPayouts.__slotkeeperPayouts;
}

export interface PayoutDeps {
  rest: RestTransport;
  bookings: BookingStore;
  payouts: PayoutStore;
  /** staffId → PayPal email (sandbox personal accounts). */
  emails: Map<string, string>;
  timeZone: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** PayPal's sender_batch_id must be unique for 30 days, so one per business day is a natural key. */
export const senderBatchId = (day: string) => `slotkeeper-payouts-${day}`;

export function payoutOutcome(transactionStatus: string | undefined): PayoutOutcome {
  switch (transactionStatus) {
    case 'SUCCESS':
      return 'paid';
    case 'PENDING':
    case 'ONHOLD':
    case 'NEW':
      return 'in_progress';
    case 'UNCLAIMED':
      // The email has no PayPal account yet; PayPal invites them and returns the money after 30 days.
      return 'unclaimed';
    case 'FAILED':
    case 'RETURNED':
    case 'BLOCKED':
    case 'REFUNDED':
    case 'REVERSED':
    case 'DENIED':
      return 'failed';
    default:
      return 'unknown';
  }
}

interface PayoutsCreateResponse {
  batch_header?: { payout_batch_id?: string; batch_status?: string };
}

interface PayoutsBatchResponse {
  batch_header?: { payout_batch_id?: string; batch_status?: string };
  total_items?: number;
  items?: Array<{
    payout_item_id?: string;
    transaction_status?: string;
    payout_item?: { sender_item_id?: string };
    errors?: { name?: string };
  }>;
}

/**
 * A day can be paid this long after it ended. Money is time-stamped when its request starts but
 * saved after the PayPal call returns (lock wait + 15 s timeout, at most one retry): a capture that
 * starts at 23:59:58 may only be saved after midnight. Waiting well past any request's duration
 * means every write stamped with the day is saved before the payout reads it.
 */
export const PAYOUT_GRACE_MS = 15 * 60 * 1000;

/**
 * The end-of-day job: pays each staff member their commission and tips for `day` with one Payouts
 * batch. Only a business day that ended at least PAYOUT_GRACE_MS ago can be paid (its earnings can't
 * change any more, except through money that completes later, which counts on its own later day,
 * so the daily cron runs after 00:15 in the business time zone). The batch is computed
 * once and stored before it is sent, so every retry sends exactly the same items with the same
 * sender_batch_id and PayPal-Request-Id; running it again for a day that was already sent only
 * refreshes the item statuses. One run per day at a time.
 */
export function runDailyPayouts(deps: PayoutDeps, day: string, now: Date = new Date()): Promise<PayoutBatchRecord> {
  if (!DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    return Promise.reject(new PayoutError('invalid_date', 400, 'day must be a date like 2026-11-01.'));
  }
  // The business day it was PAYOUT_GRACE_MS ago: everything before it is over and settled.
  const settledThrough = businessDay(new Date(now.getTime() - PAYOUT_GRACE_MS), deps.timeZone);
  if (day >= settledThrough) {
    return Promise.reject(
      new PayoutError(
        'day_not_over',
        409,
        `${day} can be paid ${PAYOUT_GRACE_MS / 60_000} minutes after it ends in ${deps.timeZone} (once in-flight payments have settled).`,
      ),
    );
  }
  return withBookingLock(`payouts-${day}`, async () => {
    let record = deps.payouts.get(day);
    if (record && record.timeZone !== deps.timeZone) {
      throw new PayoutError(
        'time_zone_changed',
        409,
        `The ${day} payout was computed in ${record.timeZone} but BUSINESS_TIME_ZONE is now ${deps.timeZone}. Set it back; changing it can pay money twice.`,
      );
    }
    if (record?.state === 'submitted') return refreshLocked(deps, record, now);
    if (record?.state === 'nothing_to_pay' || record?.state === 'needs_review') return record;

    if (!record || record.state === 'rejected') {
      // Nothing was paid yet, so the batch can be (re)computed from the bookings.
      record = buildBatch(deps, day, (record?.attempt ?? 0) + 1, now);
      deps.payouts.save(record);
      if (record.state === 'nothing_to_pay') return record;
    }
    return submitLocked(deps, record, now);
  });
}

function buildBatch(deps: PayoutDeps, day: string, attempt: number, now: Date): PayoutBatchRecord {
  const items: PayoutItemRecord[] = [];
  const skipped: PayoutBatchRecord['skipped'] = [];
  for (const earning of dailyEarnings(deps.bookings.list(), day, deps.timeZone)) {
    const receiver = deps.emails.get(earning.staffId);
    if (earning.totalCents <= 0) {
      skipped.push({ staffId: earning.staffId, reason: 'nothing_to_pay', totalCents: earning.totalCents });
    } else if (!receiver) {
      skipped.push({ staffId: earning.staffId, reason: 'no_payout_email', totalCents: earning.totalCents });
    } else {
      items.push({
        staffId: earning.staffId,
        receiver,
        amountCents: earning.totalCents,
        commissionCents: earning.commissionCents,
        tipCents: earning.tipCents,
        senderItemId: `${day}-${earning.staffId}`,
        outcome: 'unknown',
      });
    }
  }
  return {
    day,
    timeZone: deps.timeZone,
    senderBatchId: senderBatchId(day),
    attempt,
    state: items.length > 0 ? 'submitting' : 'nothing_to_pay',
    items,
    skipped,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

async function submitLocked(deps: PayoutDeps, record: PayoutBatchRecord, now: Date): Promise<PayoutBatchRecord> {
  const body = {
    sender_batch_header: {
      sender_batch_id: record.senderBatchId,
      recipient_type: 'EMAIL',
      email_subject: 'Your SlotKeeper earnings',
      email_message: `Your commission and tips for ${record.day}. Thank you!`,
    },
    items: record.items.map((item) => ({
      recipient_type: 'EMAIL',
      receiver: item.receiver,
      amount: { currency: 'USD', value: formatAmount({ currency: 'USD', cents: item.amountCents }) },
      note: `${findStaff(item.staffId)?.name ?? item.staffId}: commission ${formatAmount({ currency: 'USD', cents: item.commissionCents })} + tips ${formatAmount({ currency: 'USD', cents: item.tipCents })} for ${record.day}`,
      sender_item_id: item.senderItemId,
      recipient_wallet: 'PAYPAL',
    })),
  };

  let response: PayoutsCreateResponse;
  try {
    response = await deps.rest.request<PayoutsCreateResponse>({
      method: 'POST',
      path: '/v1/payments/payouts',
      body,
      requestId: `${record.senderBatchId}-${record.attempt}`,
    });
  } catch (err) {
    const duplicate =
      err instanceof PayPalRestError &&
      /DUPLICATE|already exists/i.test(`${err.failure.name ?? ''} ${err.failure.issue ?? ''} ${err.failure.description ?? ''}`);
    if (err instanceof PayPalRestError && (duplicate || isDefiniteRefusal(err.failure))) {
      const failure = err.failure;
      console.error('[payouts] batch rejected', { day: record.day, status: failure.status, name: failure.name, issue: failure.issue, debugId: failure.debugId });
      // The batch may exist at PayPal although this answer is a refusal: PayPal says so (duplicate
      // sender_batch_id), or an earlier send of this record had an unknown outcome and PayPal has
      // since forgotten that request id. Either way it may be paid, so staff check it; never retry.
      const maybePaid = duplicate || record.outcomeUnknownSince !== undefined;
      deps.payouts.save({ ...record, state: maybePaid ? 'needs_review' : 'rejected', lastError: failure, updatedAt: now.toISOString() });
      throw maybePaid
        ? new PayoutError('needs_review', 409, `The payout batch for ${record.day} may already exist at PayPal (${err.message}). Check it in the PayPal dashboard before paying anything by hand.`, failure)
        : new PayoutError('paypal_rejected', 422, `PayPal refused the payout batch: ${err.message}`, failure);
    }
    // Outcome unknown: keep 'submitting'; the next run sends the same request id and PayPal replays.
    const unknown = { outcomeUnknownSince: record.outcomeUnknownSince ?? now.toISOString(), updatedAt: now.toISOString() };
    if (err instanceof PayPalRestError) {
      console.error('[payouts] batch outcome unknown', { day: record.day, status: err.failure.status, debugId: err.failure.debugId });
      deps.payouts.save({ ...record, ...unknown, lastError: err.failure });
      throw new PayoutError('paypal_error', 502, 'PayPal had a problem with the payout batch. Run it again; it will not pay twice.', err.failure);
    }
    if (err instanceof PayPalUnreachableError) {
      console.error('[payouts] batch outcome unknown', { day: record.day, reason: err.message });
      deps.payouts.save({ ...record, ...unknown });
      throw new PayoutError('network_error', 502, 'Could not reach PayPal. Run it again; it will not pay twice.');
    }
    throw err;
  }

  const payoutBatchId = response.batch_header?.payout_batch_id;
  if (!payoutBatchId) {
    console.error('[payouts] batch accepted without an id; outcome unknown', { day: record.day });
    deps.payouts.save({ ...record, outcomeUnknownSince: record.outcomeUnknownSince ?? now.toISOString(), updatedAt: now.toISOString() });
    throw new PayoutError('paypal_error', 502, 'PayPal did not return a payout batch id. Run it again; it will not pay twice.');
  }
  const submitted: PayoutBatchRecord = {
    ...record,
    state: 'submitted',
    payoutBatchId,
    batchStatus: response.batch_header?.batch_status,
    lastError: undefined,
    updatedAt: now.toISOString(),
  };
  deps.payouts.save(submitted);
  return submitted;
}

/** Reads the batch and its items back from PayPal (used by the status route and payout webhooks). */
export function refreshPayouts(deps: PayoutDeps, day: string, now: Date = new Date()): Promise<PayoutBatchRecord> {
  return withBookingLock(
    `payouts-${day}`,
    async () => {
      const record = deps.payouts.get(day);
      if (!record) throw new PayoutError('not_found', 404, `No payout batch for ${day}.`);
      return record.state === 'submitted' ? refreshLocked(deps, record, now) : record;
    },
    'wait',
  );
}

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

async function refreshLocked(deps: PayoutDeps, record: PayoutBatchRecord, now: Date): Promise<PayoutBatchRecord> {
  let batch: PayoutsBatchResponse = {};
  const remoteItems: NonNullable<PayoutsBatchResponse['items']> = [];
  try {
    // Page through the items (a batch can hold up to 15,000); stop on a short page or when all are read.
    for (let page = 1; page <= MAX_PAGES; page++) {
      batch = await deps.rest.request<PayoutsBatchResponse>({
        method: 'GET',
        path: `/v1/payments/payouts/${encodeURIComponent(record.payoutBatchId!)}?page=${page}&page_size=${PAGE_SIZE}&total_required=true`,
      });
      const items = batch.items ?? [];
      remoteItems.push(...items);
      const total = batch.total_items ?? remoteItems.length;
      if (items.length < PAGE_SIZE || remoteItems.length >= total) break;
    }
  } catch (err) {
    if (err instanceof PayPalRestError) {
      throw new PayoutError('paypal_error', 502, `PayPal could not return the payout status: ${err.message}`, err.failure);
    }
    if (err instanceof PayPalUnreachableError) {
      throw new PayoutError('network_error', 502, 'Could not reach PayPal for the payout status.');
    }
    throw err;
  }

  const items = record.items.map((item) => {
    const remote = remoteItems.find((candidate) => candidate.payout_item?.sender_item_id === item.senderItemId);
    if (!remote) return item;
    const status = remote.transaction_status;
    return {
      ...item,
      payoutItemId: remote.payout_item_id ?? item.payoutItemId,
      transactionStatus: status,
      outcome: payoutOutcome(status),
      error: remote.errors?.name ?? (payoutOutcome(status) === 'failed' ? item.error : undefined),
    };
  });
  for (const item of items) {
    if (item.outcome === 'failed') {
      console.error('[payouts] item failed', { day: record.day, staffId: item.staffId, status: item.transactionStatus, error: item.error });
    }
  }
  const refreshed: PayoutBatchRecord = {
    ...record,
    batchStatus: batch.batch_header?.batch_status ?? record.batchStatus,
    items,
    updatedAt: now.toISOString(),
  };
  deps.payouts.save(refreshed);
  return refreshed;
}
