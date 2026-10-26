import 'server-only';

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
// at once would overwrite each other's result (F-003). Process-local, like the memory store; the
// Postgres store needs a row lock or version check instead.
const lockState = globalThis as typeof globalThis & { __slotkeeperBookingLocks?: Map<string, Promise<void>> };

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
  try {
    if (previous) await previous;
    return await run();
  } finally {
    release();
    if (tails.get(bookingId) === tail) tails.delete(bookingId);
  }
}
