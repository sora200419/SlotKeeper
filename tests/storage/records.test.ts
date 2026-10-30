import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBookingStore, type Booking } from '@/lib/booking/store';
import { getAuditLog, getPlanStore, type Plan } from '@/lib/copilot/plan';
import { getPayoutStore, type PayoutBatchRecord } from '@/lib/paypal/payouts';
import { connectStorage, flushWrites, persist, queuedWrites, resetStorage, type Database } from '@/lib/storage/records';
import { withBookingLock } from '@/lib/booking/locks';

const booking = (id: string, status: Booking['status'] = 'awaiting_deposit'): Booking => ({
  id,
  serviceId: 'haircut',
  customerName: 'Ana',
  startsAt: '2026-11-02T10:00:00.000Z',
  deposit: { currency: 'USD', cents: 1000 },
  status,
  createdAt: '2026-11-01T10:00:00.000Z',
});

const plan = (id: string, status: Plan['status']): Plan => ({ id, request: 'r', summary: 's', steps: [], status, createdAt: '2026-11-01T10:00:00.000Z' });

const pg = (db: PGlite): Database => db as unknown as Database;

/** Drops every in-memory store, as a process restart does. Postgres keeps its data. */
function restartMemory() {
  const g = globalThis as Record<string, unknown>;
  for (const key of ['__slotkeeperBookings', '__slotkeeperPayouts', '__slotkeeperPlans', '__slotkeeperAudit']) delete g[key];
  resetStorage();
}

async function restart(db: PGlite) {
  await flushWrites();
  restartMemory();
  await connectStorage(pg(db));
}

describe('Postgres storage (real SQL through PGlite)', () => {
  let db: PGlite;

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    restartMemory();
    db = new PGlite();
    await connectStorage(pg(db));
  });
  afterEach(async () => {
    await flushWrites();
    restartMemory();
    await db.close();
    vi.restoreAllMocks();
  });

  it('a booking survives a restart, with its latest state', async () => {
    getBookingStore().save(booking('b1'));
    getBookingStore().save(booking('b1', 'deposit_held'));
    await restart(db);
    expect(getBookingStore().get('b1')).toMatchObject({ id: 'b1', status: 'deposit_held' });
  });

  it('payouts survive a restart and stay findable by batch id', async () => {
    const record = { day: '2026-11-01', state: 'submitted', payoutBatchId: 'BATCH-1', items: [] } as unknown as PayoutBatchRecord;
    getPayoutStore().save(record);
    await restart(db);
    expect(getPayoutStore().findByPayoutBatchId('BATCH-1')).toMatchObject({ day: '2026-11-01' });
  });

  it('the audit log keeps its order across a restart', async () => {
    const entry = (stepIndex: number) => ({ at: 'x', planId: 'p1', stepIndex, action: 'void_deposit' as const, outcome: 'done' as const, why: 'w' });
    for (const i of [0, 1, 2]) getAuditLog().append(entry(i));
    await restart(db);
    expect(getAuditLog().list().map((e) => e.stepIndex)).toEqual([2, 1, 0]);
  });

  it('a plan cut off by a restart comes back failed, so it can never be approved again', async () => {
    getPlanStore().save(plan('p1', 'executing'));
    getPlanStore().save(plan('p2', 'proposed'));
    await restart(db);
    expect(getPlanStore().get('p1')).toMatchObject({ status: 'failed', results: [] });
    expect(getPlanStore().get('p2')).toMatchObject({ status: 'proposed' });
    // The correction is saved too: a second restart still sees it.
    await restart(db);
    expect(getPlanStore().get('p1')).toMatchObject({ status: 'failed' });
  });

  it('finishing a lock waits until the record reached Postgres', async () => {
    await withBookingLock('b9', async () => {
      getBookingStore().save(booking('b9', 'completed'));
    });
    expect(queuedWrites()).toBe(0);
    const { rows } = await db.query<{ status: string }>(`SELECT data->>'status' AS status FROM records WHERE id = 'b9'`);
    expect(rows).toEqual([{ status: 'completed' }]);
  });

  it('a name Postgres cannot store never blocks the records behind it', async () => {
    getBookingStore().save({ ...booking('evil'), customerName: 'A\u0000B\ud83d' });
    getBookingStore().save(booking('good'));
    expect(await flushWrites()).toBe(true);
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM records WHERE kind = 'booking' ORDER BY id`);
    expect(rows.map((r) => r.id)).toEqual(['evil', 'good']);
  });

  it('a record refused for good leaves the queue; the rest still land', async () => {
    const real = pg(db);
    let refused = false;
    const picky: Database = {
      query: (sql, params) => {
        if (params?.[1] === 'bad' && !refused) {
          refused = true;
          return Promise.reject(Object.assign(new Error('bad data'), { code: '22P05' }));
        }
        return real.query(sql, params);
      },
    };
    await flushWrites();
    resetStorage();
    await connectStorage(picky);
    persist('booking', 'bad', {});
    persist('booking', 'next', {});
    expect(await flushWrites()).toBe(true);
    expect(queuedWrites()).toBe(0);
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM records WHERE id IN ('bad', 'next')`);
    expect(rows.map((r) => r.id)).toEqual(['next']);
  });

  it('a failed lock holder is flushed as well: a pending money action must not be lost', async () => {
    await withBookingLock('b8', async () => {
      getBookingStore().save(booking('b8', 'deposit_needs_review'));
      throw new Error('boom');
    }).catch(() => undefined);
    expect(queuedWrites()).toBe(0);
  });
});

describe('startStorageOrExit', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.doUnmock('pg');
    vi.resetModules();
    restartMemory();
  });

  it('stops the process when the configured database cannot be read, without logging its password', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.stubEnv('DATABASE_URL', 'postgres://demo:hunter2@db.test/x');
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.resetModules();
    vi.doMock('pg', () => ({
      Pool: class {
        on() {}
        async query() {
          throw Object.assign(new Error('connect failed postgres://demo:hunter2@db.test/x'), { code: 'ECONNREFUSED' });
        }
      },
    }));
    const { startStorageOrExit } = await import('@/lib/storage/start');
    const run = startStorageOrExit();
    await vi.runAllTimersAsync();
    await run;
    vi.useRealTimers();
    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.stringify(logs.mock.calls)).not.toContain('hunter2');
  });

  it('registers a SIGTERM handler', async () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const on = vi.spyOn(process, 'on').mockImplementation((() => process) as never);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const { startStorageOrExit } = await import('@/lib/storage/start');
    await startStorageOrExit();
    const handler = on.mock.calls.find(([signal]) => signal === 'SIGTERM')?.[1] as (() => void) | undefined;
    expect(handler).toBeDefined();
    // A second signal (npm forwards one) must neither crash nor run the shutdown twice.
    handler!();
    handler!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
  });

  it('on shutdown it writes what is queued before it exits', async () => {
    const order: string[] = [];
    await connectStorage({
      query: async (sql, params) => {
        if (sql.startsWith('INSERT')) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          order.push(`written ${params![1]}`);
        }
        return { rows: [] };
      },
    });
    const { shutdown } = await import('@/lib/storage/start');
    persist('booking', 'queued', {});
    await shutdown(() => order.push('exit'));
    expect(order).toEqual(['written queued', 'exit']);
  });

  it('on shutdown it exits only after running money flows ended and their records landed', async () => {
    const order: string[] = [];
    await connectStorage({
      query: async (sql, params) => {
        if (sql.startsWith('INSERT')) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          order.push(`written ${params![1]}`);
        }
        return { rows: [] };
      },
    });
    const { shutdown } = await import('@/lib/storage/start');
    let finish = () => {};
    const flow = withBookingLock('busy', () => new Promise<void>((resolve) => (finish = resolve)));
    const stopped = shutdown(() => order.push('exit'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(order).toEqual([]);

    persist('booking', 'money', {});
    finish();
    await flow;
    await stopped;
    expect(order).toEqual(['written money', 'exit']);
  });

  it('stays up in memory mode when no database is configured', async () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const { startStorageOrExit } = await import('@/lib/storage/start');
    await startStorageOrExit();
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('write queue', () => {
  const flaky = (failures: number) => {
    const writes: unknown[][] = [];
    let left = failures;
    const db: Database = {
      query: async (sql, params) => {
        if (sql.startsWith('INSERT')) {
          if (left-- > 0) throw Object.assign(new Error('connect failed postgres://user:hunter2@db/app'), { code: 'ECONNREFUSED' });
          writes.push(params!);
        }
        return { rows: [] };
      },
    };
    return { db, writes };
  };

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    restartMemory();
  });
  afterEach(() => {
    restartMemory();
    vi.restoreAllMocks();
  });

  it('retries a failed write and never logs the connection string', async () => {
    const { db, writes } = flaky(1);
    await connectStorage(db);
    persist('booking', 'b1', { n: 1 });
    expect(await flushWrites()).toBe(true);
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('hunter2');
  });

  it('only the newest version of a record is written after an outage', async () => {
    const { db, writes } = flaky(1);
    await connectStorage(db);
    persist('booking', 'b1', { n: 1 });
    persist('booking', 'b1', { n: 2 });
    await flushWrites();
    expect(writes.at(-1)).toEqual(['booking', 'b1', '{"n":2}']);
  });

  it('a database outage never fails the caller: flushing gives up after its timeout', async () => {
    const { db } = flaky(1000);
    await connectStorage(db);
    persist('booking', 'b1', { n: 1 });
    expect(await flushWrites(20)).toBe(false);
    expect(queuedWrites()).toBe(1);
  });

  // The gap lasts a few microtasks and its position depends on the runtime, so every position is tried.
  it.each(Array.from({ length: 16 }, (_, ticks) => ticks))('a save %i microtasks after the last write is still written', async (ticks) => {
    const writes: unknown[] = [];
    let onWrite = () => {};
    const db: Database = {
      query: async (sql, params) => {
        if (sql.startsWith('INSERT')) {
          writes.push(params![1]);
          onWrite();
        }
        return { rows: [] };
      },
    };
    await connectStorage(db);
    onWrite = () => {
      onWrite = () => {};
      void (async () => {
        for (let i = 0; i < ticks; i++) await null;
        persist('booking', 'late', {});
      })();
    };
    persist('booking', 'first', {});
    await flushWrites();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await flushWrites();
    expect(writes).toEqual(['first', 'late']);
    expect(queuedWrites()).toBe(0);
  });

  it('without a database nothing is queued', async () => {
    persist('booking', 'b1', { n: 1 });
    expect(queuedWrites()).toBe(0);
    expect(await flushWrites()).toBe(true);
  });
});
