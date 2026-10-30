/**
 * Durable storage behind the synchronous in-memory stores. Reads stay in memory, so the stores keep
 * their synchronous interfaces; every save is also queued and written to Postgres in the background.
 * Records are loaded back once at startup (instrumentation.ts), before the first request.
 *
 * One process normally owns the data, as the in-process booking locks assume. During a deploy two
 * overlap, so every record carries a revision, and a write says which revision it was based on:
 * - A flow that spans an await holds the record's lock (F-003). Taking it re-reads the record, then
 *   pins it: nothing from the other process touches the copy until the lock ends, so everything the
 *   flow saves is based on the revision it read.
 * - Saves outside a lock read and write in one synchronous step, so they can't go stale in between.
 * - If Postgres has moved on anyway, the write is refused and resolveConflict takes over.
 * - followChanges picks up what the other process saved, including records it created.
 */

export type RecordKind = 'booking' | 'payout' | 'plan' | 'audit';

/** The part of a pg Pool used here; tests pass PGlite, which answers real SQL in-process. */
export interface Database {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** How a store takes in a record that changed in Postgres. */
export interface StoreHooks {
  /** Another process saved a newer version: replace the copy in memory. */
  apply(data: unknown): void;
  /** Our save lost to a newer version, already applied: flag the record for a person to check. */
  onConflict?(data: unknown): void;
}

interface QueuedWrite {
  kind: RecordKind;
  id: string;
  json: string;
}

interface StoredRow {
  kind: RecordKind;
  id: string;
  revision: number;
  data: unknown;
  writer?: string | null;
}

interface StorageState {
  /** Marks this process's own writes in Postgres. */
  writerId: string;
  /** Records a running flow holds the lock of; the other process's changes wait until it ends. */
  pinned: Set<string>;
  /** Records whose save lost to the other process and that a pinned flow may still be saving. */
  lost: Set<string>;
  db?: Database;
  loaded: Map<RecordKind, Map<string, unknown>>;
  /** The revision in Postgres that this process last read or wrote, per record. */
  revisions: Map<string, number>;
  /** Latest unwritten version of each record; saves to one record collapse into one write. */
  dirty: Map<string, QueuedWrite>;
  draining?: Promise<void>;
  hooks: Map<RecordKind, StoreHooks>;
  /** Database time of the last look for changes. */
  followedTo?: unknown;
  follower?: NodeJS.Timeout;
}

const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;
const FLUSH_TIMEOUT_MS = 5_000;
const FOLLOW_INTERVAL_MS = 10_000;
/** A commit can land just behind a look at the clock, so each look reaches back this far. */
const FOLLOW_OVERLAP_SECONDS = 30;
const REFRESH_TIMEOUT_MS = 1_000;

// Kept on globalThis: instrumentation.ts and the route handlers are separate bundles in one process.
const global_ = globalThis as typeof globalThis & { __slotkeeperStorage?: StorageState };

function state(): StorageState {
  return (global_.__slotkeeperStorage ??= {
    writerId: crypto.randomUUID(),
    pinned: new Set(),
    lost: new Set(),
    loaded: new Map(),
    revisions: new Map(),
    dirty: new Map(),
    hooks: new Map(),
  });
}

const keyOf = (kind: string, id: string) => `${kind}:${id}`;

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
      revision integer NOT NULL DEFAULT 1,
      seq bigserial,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (kind, id)
    )
  `);
  // For a table created before these columns existed.
  await db.query('ALTER TABLE records ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1');
  await db.query('ALTER TABLE records ADD COLUMN IF NOT EXISTS writer text');
  await db.query('CREATE INDEX IF NOT EXISTS records_updated_at ON records (updated_at)');
  // An instance on an older release (mid-deploy, or after a rollback) writes without touching the
  // revision. Postgres counts that write anyway, so this process sees it and can't overwrite it.
  await db.query(`
    CREATE OR REPLACE FUNCTION records_count_revision() RETURNS trigger AS $$
    BEGIN
      IF NEW.revision = OLD.revision THEN
        NEW.revision := OLD.revision + 1;
        NEW.writer := NULL;
      END IF;
      RETURN NEW;
    END
    $$ LANGUAGE plpgsql
  `);
  await db.query('DROP TRIGGER IF EXISTS records_count_revision ON records');
  await db.query('CREATE TRIGGER records_count_revision BEFORE UPDATE ON records FOR EACH ROW EXECUTE FUNCTION records_count_revision()');
  const clock = (await db.query('SELECT now() AS now')).rows[0] as { now: unknown } | undefined;
  // seq keeps insertion order, which the audit log depends on; updates leave it alone.
  const { rows } = await db.query('SELECT kind, id, revision, data FROM records ORDER BY seq');
  const s = state();
  const loaded = new Map<RecordKind, Map<string, unknown>>();
  for (const row of rows as StoredRow[]) {
    if (!loaded.has(row.kind)) loaded.set(row.kind, new Map());
    loaded.get(row.kind)!.set(row.id, row.data);
    s.revisions.set(keyOf(row.kind, row.id), row.revision);
  }
  s.loaded = loaded;
  s.followedTo = clock?.now;
  s.db = db;
}

/** Records loaded at startup, for a store to seed itself with when it is first created. */
export function loadedRecords<T>(kind: RecordKind): T[] {
  return [...(state().loaded.get(kind)?.values() ?? [])] as T[];
}

export function registerStore(kind: RecordKind, hooks: StoreHooks): void {
  state().hooks.set(kind, hooks);
}

/** True if the record was newer than ours and is now in memory. */
function applyRemote(s: StorageState, row: StoredRow): boolean {
  const key = keyOf(row.kind, row.id);
  // An unwritten local save meets the new revision when it is written. A pinned record catches up
  // when its lock ends: moving the revision now would let a save based on the old copy through.
  if (s.dirty.has(key) || s.pinned.has(key) || row.revision <= (s.revisions.get(key) ?? 0)) return false;
  s.revisions.set(key, row.revision);
  const hooks = s.hooks.get(row.kind);
  if (hooks) hooks.apply(row.data);
  else {
    // The store doesn't exist yet: it will seed itself from here.
    if (!s.loaded.has(row.kind)) s.loaded.set(row.kind, new Map());
    s.loaded.get(row.kind)!.set(row.id, row.data);
  }
  return true;
}

/**
 * Picks up what another process saved. Without it, a booking the old instance created during a
 * deploy would never appear here, and bookings it changed would stay stale until they conflict.
 */
export async function pollChanges(): Promise<void> {
  const s = state();
  if (!s.db) return;
  const clock = (await s.db.query('SELECT now() AS now')).rows[0] as { now: unknown };
  const { rows } = await s.db.query(
    `SELECT kind, id, revision, data FROM records WHERE updated_at > $1::timestamptz - make_interval(secs => ${FOLLOW_OVERLAP_SECONDS}) ORDER BY seq`,
    [s.followedTo],
  );
  for (const row of rows as StoredRow[]) applyRemote(s, row);
  s.followedTo = clock.now;
}

export function followChanges(): void {
  const s = state();
  if (s.follower) return;
  s.follower = setInterval(() => {
    pollChanges().catch((err: unknown) => console.error('[storage] could not read changes', { error: describeDbError(err) }));
  }, FOLLOW_INTERVAL_MS);
  s.follower.unref();
}

/**
 * Reads one record from Postgres, so a money flow starts from the latest version rather than a copy
 * that may be behind. Waits a moment at most: during an outage the flow carries on from memory, and
 * the revision check still stops a stale save from overwriting anything.
 */
export async function refreshRecord(kind: RecordKind, id: string): Promise<StoredRow | undefined> {
  const s = state();
  if (!s.db) return undefined;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), REFRESH_TIMEOUT_MS);
    timer.unref();
  });
  try {
    const read = s.db.query('SELECT kind, id, revision, data FROM records WHERE kind = $1 AND id = $2', [kind, id]);
    // A read that loses the race must not surface later as an unhandled rejection.
    read.catch(() => undefined);
    const result = await Promise.race([read, timeout]);
    if (result === 'timeout') {
      console.error('[storage] refresh timed out; using the copy in memory', { kind, id });
      return undefined;
    }
    const row = result.rows[0] as StoredRow | undefined;
    if (row) applyRemote(s, row);
    return row;
  } catch (err) {
    console.error('[storage] refresh failed; using the copy in memory', { kind, id, error: describeDbError(err) });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** A flow took the record's lock: hold off the other process's changes until releaseRecord. */
export function pinRecord(kind: RecordKind, id: string): void {
  const s = state();
  if (s.db) s.pinned.add(keyOf(kind, id));
}

/** The lock is ending. Catches up on what was held off, and settles a conflict the flow ran into. */
export async function releaseRecord(kind: RecordKind, id: string): Promise<void> {
  const s = state();
  const key = keyOf(kind, id);
  if (!s.pinned.delete(key)) return;
  const conflicted = s.lost.delete(key);
  // After a conflict memory holds what the flow saved, so the stored version must replace it.
  if (conflicted) s.revisions.delete(key);
  const row = await refreshRecord(kind, id);
  if (conflicted && row) s.hooks.get(kind)?.onConflict?.(row.data);
}

/** True if this process's save of the record has lost to another process during the current lock. */
export function takeConflict(kind: RecordKind, id: string): boolean {
  return state().lost.has(keyOf(kind, id));
}

/** Writes if Postgres still holds the revision this save was based on. Returns the new revision. */
async function writeOne(db: Database, s: StorageState, write: QueuedWrite, expected: number): Promise<number | undefined> {
  const { rows } = await db.query(
    `INSERT INTO records (kind, id, data, writer) VALUES ($1, $2, $3::jsonb, $5)
     ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, writer = EXCLUDED.writer, revision = records.revision + 1, updated_at = now()
     WHERE records.revision = $4
     RETURNING revision`,
    [write.kind, write.id, write.json, expected, s.writerId],
  );
  return (rows[0] as { revision: number } | undefined)?.revision;
}

/**
 * Postgres has a revision we didn't expect. If the last writer was this process, an earlier write
 * landed and only its answer was lost, so the write is simply retried from there. Otherwise another
 * process saved first: its version stays, ours (the newest, as everything queued was based on the same
 * old copy) is kept as a `conflict` record so nothing is destroyed, and the record is flagged for a
 * person, because each side may have acted on money the other didn't see. The revision only moves
 * once the losing version is safely stored: a retry from the new revision would overwrite the winner.
 */
async function resolveConflict(db: Database, s: StorageState, key: string, write: QueuedWrite): Promise<void> {
  const { rows } = await db.query('SELECT kind, id, revision, data, writer FROM records WHERE kind = $1 AND id = $2', [write.kind, write.id]);
  const row = rows[0] as StoredRow | undefined;
  if (!row) {
    // The row was removed by hand; the next attempt inserts it again.
    s.revisions.delete(key);
    return;
  }
  if (row.writer === s.writerId) {
    s.revisions.set(key, row.revision);
    return;
  }
  const newest = s.dirty.get(key) ?? write;
  await db.query(
    `INSERT INTO records (kind, id, data) VALUES ('conflict', $1, jsonb_build_object('kind', $2::text, 'id', $3::text, 'lost', $4::jsonb))`,
    [`${key}@${row.revision}-${crypto.randomUUID()}`, write.kind, write.id, newest.json],
  );
  console.error('[storage] a save lost to a newer version; flagged for review', { kind: write.kind, id: write.id, revision: row.revision });
  s.revisions.set(key, row.revision);
  s.dirty.delete(key);
  if (s.pinned.has(key)) {
    // The flow is still running on the old copy: releaseRecord finishes this when its lock ends.
    s.lost.add(key);
    return;
  }
  const hooks = s.hooks.get(write.kind);
  hooks?.apply(row.data);
  hooks?.onConflict?.(row.data);
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
      const revision = await writeOne(db, s, write, s.revisions.get(key) ?? 0);
      if (revision === undefined) await resolveConflict(db, s, key, write);
      else {
        s.revisions.set(key, revision);
        // A newer save during the write replaced the entry; that one still has to be written.
        if (s.dirty.get(key) === write) s.dirty.delete(key);
      }
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
  const key = keyOf(kind, id);
  // The flow is working from a copy that already lost; another save from it would overwrite the winner.
  if (s.lost.has(key)) return;
  s.dirty.set(key, { kind, id, json: JSON.stringify(data, storable) });
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
  const s = global_.__slotkeeperStorage;
  if (s?.follower) clearInterval(s.follower);
  delete global_.__slotkeeperStorage;
}
