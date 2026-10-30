/**
 * Durable storage behind the synchronous in-memory stores. Reads stay in memory, so the stores keep
 * their synchronous interfaces; every save is also queued and written to Postgres in the background.
 * Records are loaded back once at startup (instrumentation.ts), before the first request.
 *
 * This relies on one server process owning the data, as the in-process booking locks already do:
 * render.yaml runs a single instance.
 */

export type RecordKind = 'booking' | 'payout' | 'plan' | 'audit';

/** The part of a pg Pool used here; tests pass PGlite, which answers real SQL in-process. */
export interface Database {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

interface QueuedWrite {
  kind: RecordKind;
  id: string;
  json: string;
}

interface StorageState {
  db?: Database;
  loaded: Map<RecordKind, unknown[]>;
  /** Latest unwritten version of each record; saves to one record collapse into one write. */
  dirty: Map<string, QueuedWrite>;
  draining?: Promise<void>;
}

const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;
const FLUSH_TIMEOUT_MS = 5_000;

// Kept on globalThis: instrumentation.ts and the route handlers are separate bundles in one process.
const global_ = globalThis as typeof globalThis & { __slotkeeperStorage?: StorageState };

function state(): StorageState {
  return (global_.__slotkeeperStorage ??= { loaded: new Map(), dirty: new Map() });
}

/** Only the error's name, code and first line: a driver error can quote the connection string. */
export function describeDbError(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error';
  const code = (err as { code?: unknown }).code;
  const firstLine = err.message.split('\n', 1)[0].replace(/\w+:\/\/\S+/g, '<url>').slice(0, 200);
  return `${err.name}${typeof code === 'string' ? ` ${code}` : ''}: ${firstLine}`;
}

/** Creates the table if needed and loads every record. Throws if the database can't be read. */
export async function connectStorage(db: Database): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS records (
      kind text NOT NULL,
      id text NOT NULL,
      data jsonb NOT NULL,
      seq bigserial,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (kind, id)
    )
  `);
  // seq keeps insertion order, which the audit log depends on; updates leave it alone.
  const { rows } = await db.query('SELECT kind, data FROM records ORDER BY seq');
  const loaded = new Map<RecordKind, unknown[]>();
  for (const row of rows as Array<{ kind: RecordKind; data: unknown }>) {
    const list = loaded.get(row.kind) ?? [];
    list.push(row.data);
    loaded.set(row.kind, list);
  }
  const s = state();
  s.loaded = loaded;
  s.db = db;
}

/** Records loaded at startup, for a store to seed itself with when it is first created. */
export function loadedRecords<T>(kind: RecordKind): T[] {
  return (state().loaded.get(kind) ?? []) as T[];
}

async function writeOne(db: Database, write: QueuedWrite): Promise<void> {
  await db.query(
    `INSERT INTO records (kind, id, data) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [write.kind, write.id, write.json],
  );
}

/**
 * Postgres refuses this data for good (SQLSTATE class 22, bad data), so retrying can never help. Such
 * a record must leave the queue: left at the front it would block every record behind it.
 */
function isPermanent(err: unknown): boolean {
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && code.startsWith('22');
}

/** Writes until nothing is queued. A failing write is retried with growing delays. */
async function drain(db: Database, s: StorageState): Promise<void> {
  let delay = FIRST_RETRY_MS;
  while (s.dirty.size > 0) {
    const [key, write] = s.dirty.entries().next().value!;
    try {
      await writeOne(db, write);
      // A newer save during the write replaced the entry; that one still has to be written.
      if (s.dirty.get(key) === write) s.dirty.delete(key);
      delay = FIRST_RETRY_MS;
    } catch (err) {
      if (isPermanent(err)) {
        console.error('[storage] record refused by Postgres; dropped from the queue', { kind: write.kind, id: write.id, error: describeDbError(err) });
        if (s.dirty.get(key) === write) s.dirty.delete(key);
        continue;
      }
      console.error('[storage] write failed; will retry', { kind: write.kind, id: write.id, queued: s.dirty.size, error: describeDbError(err) });
      await new Promise((resolve) => setTimeout(resolve, delay).unref());
      delay = Math.min(delay * 2, MAX_RETRY_MS);
    }
  }
}

function startDraining(s: StorageState): void {
  const db = s.db;
  if (s.draining || !db) return;
  // Deferred a tick, so s.draining is set before any write starts and two drains can't run at once.
  s.draining = Promise.resolve().then(() => drain(db, s)).finally(() => {
    s.draining = undefined;
    // A save can land between the loop ending and this line, with nothing left to write it.
    if (s.dirty.size > 0) startDraining(s);
  });
}

/** Postgres jsonb has no NUL character and refuses half of a surrogate pair. */
function storable(_key: string, value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/\u0000/g, '').replace(/[\uD800-\uDFFF]/gu, '�') : value;
}

/** Queues a record for Postgres. Does nothing without a database (local dev, unit tests). */
export function persist(kind: RecordKind, id: string, data: unknown): void {
  const s = state();
  if (!s.db) return;
  s.dirty.set(`${kind}:${id}`, { kind, id, json: JSON.stringify(data, storable) });
  startDraining(s);
}

/**
 * Waits until queued writes reached Postgres, up to `timeoutMs`. Money flows call this before they
 * answer, so a recorded capture survives a restart right after it. Never throws: the money has already
 * moved, so a database outage must not turn that into an error. The queue keeps retrying.
 */
export async function flushWrites(timeoutMs = FLUSH_TIMEOUT_MS): Promise<boolean> {
  const s = state();
  if (!s.draining) return true;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref();
  });
  // A loop, not one wait: a drain that ends can start another for records saved at that moment.
  while (s.draining) {
    if ((await Promise.race([s.draining, timeout])) === 'timeout') {
      console.error('[storage] writes are still queued after waiting', { queued: s.dirty.size });
      return false;
    }
  }
  clearTimeout(timer);
  return true;
}

/** How many records have not reached Postgres yet. */
export function queuedWrites(): number {
  return state().dirty.size;
}

/** Forgets the connection, queue and loaded records. For tests, which simulate a restart with it. */
export function resetStorage(): void {
  delete global_.__slotkeeperStorage;
}
