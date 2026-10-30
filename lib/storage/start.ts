import { Pool } from 'pg';
import { locksIdle } from '@/lib/booking/locks';
import { connectStorage, describeDbError, flushWrites } from './records';

const ATTEMPTS = 5;
const SHUTDOWN_LOCKS_MS = 15_000;
const SHUTDOWN_FLUSH_MS = 8_000;
const CONNECT_TIMEOUT_MS = 5_000;
const QUERY_TIMEOUT_MS = 10_000;

/** Lets running money flows finish and their records land, then exits. Stays inside Render's 30 s. */
export async function shutdown(exit: (code: number) => void = process.exit): Promise<void> {
  await locksIdle(SHUTDOWN_LOCKS_MS);
  await flushWrites(SHUTDOWN_FLUSH_MS);
  exit(0);
}

/**
 * A deploy stops the process with SIGTERM. Next.js would exit as soon as its server closes, cutting
 * off queued writes, so render.yaml sets NEXT_MANUAL_SIG_HANDLE and this handler decides when to exit.
 */
export async function startStorageOrExit(): Promise<void> {
  // `on`, with a guard: npm can forward a second SIGTERM, which must not kill the process mid-flush.
  let stopping = false;
  process.on('SIGTERM', () => {
    if (stopping) return;
    stopping = true;
    void shutdown();
  });
  try {
    await startStorage();
  } catch (err) {
    console.error('[storage] stopping the server', { error: describeDbError(err) });
    // Next.js only reports a failed instrumentation hook and leaves the process running, unserved.
    process.exit(1);
  }
}

/**
 * Connects to DATABASE_URL and loads saved records. A database that was configured but can't be read
 * stops the server on purpose: running on empty memory would look like every booking had vanished,
 * and on Render a failed start leaves the previous deploy serving.
 */
export async function startStorage(databaseUrl: string | undefined = process.env.DATABASE_URL): Promise<void> {
  if (!databaseUrl?.trim()) {
    console.warn('[storage] DATABASE_URL is not set: bookings live in memory and are lost on restart.');
    return;
  }
  const pool = new Pool({
    connectionString: databaseUrl.trim(),
    max: 5,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  });
  // An idle client dropping (a database restart) surfaces here; without a listener it kills the process.
  pool.on('error', (err) => console.error('[storage] idle connection failed', { error: describeDbError(err) }));

  for (let attempt = 1; ; attempt++) {
    try {
      await connectStorage(pool);
      console.info('[storage] loaded saved records from Postgres');
      return;
    } catch (err) {
      console.error('[storage] could not load records', { attempt, error: describeDbError(err) });
      if (attempt === ATTEMPTS) {
        throw new Error(`Could not load records from Postgres after ${ATTEMPTS} attempts: ${describeDbError(err)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    }
  }
}
