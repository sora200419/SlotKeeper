import 'server-only';
import { flushWrites, pinRecord, refreshRecord, releaseRecord, type RecordKind } from '@/lib/storage/records';

/** Another money action holds the booking (staff actions only; others wait). Maps to HTTP 409. */
export class BookingBusyError extends Error {
  readonly code = 'pending_action';
  readonly httpStatus = 409;
  constructor() {
    super('Another money action on this booking is in progress. Try again in a moment.');
    this.name = 'BookingBusyError';
  }
}

// Per-booking lock. Every money flow reads the booking, awaits PayPal, then writes it back, so two
// at once would overwrite each other's result (F-003). Process-local: render.yaml runs one instance.
// Instances overlap briefly in a deploy, so the record is re-read here and lib/storage/records.ts
// refuses a save based on an old revision.
const lockState = globalThis as typeof globalThis & { __slotkeeperBookingLocks?: Map<string, Promise<void>> };

/** Lock ids name a record ("plan-<id>", "payouts-<day>", or a booking id); "slots" guards no record. */
function lockedRecord(lockId: string): [RecordKind, string] | undefined {
  if (lockId === 'slots') return undefined;
  if (lockId.startsWith('plan-')) return ['plan', lockId.slice('plan-'.length)];
  if (lockId.startsWith('payouts-')) return ['payout', lockId.slice('payouts-'.length)];
  return ['booking', lockId];
}

/** Waits until no money flow holds a lock, up to `timeoutMs`. Used when the server shuts down. */
export async function locksIdle(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((lockState.__slotkeeperBookingLocks?.size ?? 0) > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const held = lockState.__slotkeeperBookingLocks?.size ?? 0;
  if (held > 0) console.error('[locks] stopping with money flows still running; check them in PayPal', { held });
}

/**
 * Runs `run` while holding the booking's lock.
 * - "reject": staff actions fail fast with 409 when another action is in flight.
 * - "wait": webhooks and the customer's own checkout queue behind it instead.
 */
export async function withBookingLock<T>(
  bookingId: string,
  run: () => Promise<T>,
  mode: 'reject' | 'wait' = 'reject',
): Promise<T> {
  const tails = (lockState.__slotkeeperBookingLocks ??= new Map());
  const previous = tails.get(bookingId);
  if (previous && mode === 'reject') throw new BookingBusyError();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  // `mine` only ever resolves, so a failed holder never poisons the queue.
  const tail = (previous ?? Promise.resolve()).then(() => mine);
  tails.set(bookingId, tail);
  const record = lockedRecord(bookingId);
  try {
    if (previous) await previous;
    if (record) {
      await refreshRecord(...record);
      pinRecord(...record);
    }
    return await run();
  } finally {
    // Before answering: a money result must survive a restart right after the response.
    await flushWrites();
    if (record) await releaseRecord(...record);
    release();
    if (tails.get(bookingId) === tail) tails.delete(bookingId);
  }
}
