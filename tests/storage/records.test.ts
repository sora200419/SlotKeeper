import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBookingStore, type Booking } from '@/lib/booking/store';
import { approvePlan, rejectPlan, type ExecuteDeps } from '@/lib/copilot/execute';
import { getAuditLog, getPlanStore, type Plan } from '@/lib/copilot/plan';
import { getPayoutStore, type PayoutBatchRecord } from '@/lib/paypal/payouts';
import { onBookingChange } from '@/lib/booking/events';
import { connectStorage, flushWrites, persist, pollChanges, queuedWrites, resetStorage, type Database } from '@/lib/storage/records';
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

describe('two instances overlapping during a deploy (real SQL through PGlite)', () => {
  let db: PGlite;

  /** The other instance saving a record: everything it does reaches this one only through Postgres. */
  const otherInstanceSaves = (kind: string, id: string, data: unknown) =>
    db.query(
      `INSERT INTO records (kind, id, data, writer) VALUES ($1, $2, $3::jsonb, 'other-instance')
       ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, writer = EXCLUDED.writer, revision = records.revision + 1, updated_at = now()`,
      [kind, id, JSON.stringify(data)],
    );
  const stored = async (id: string) => (await db.query<{ data: Booking; revision: number }>(`SELECT data, revision FROM records WHERE kind = 'booking' AND id = $1`, [id])).rows[0];
  const conflicts = async () => (await db.query<{ id: string; data: { kind: string; id: string; lost: Booking } }>(`SELECT id, data FROM records WHERE kind = 'conflict'`)).rows;

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

  it('a save from an old copy never overwrites what the other instance saved', async () => {
    getBookingStore().save(booking('b1', 'deposit_held'));
    await flushWrites();
    await otherInstanceSaves('booking', 'b1', { ...booking('b1'), status: 'completed', hold: { capture: { captureId: 'CAP-1' } } });

    getBookingStore().save({ ...booking('b1'), status: 'cancelled' });
    await flushWrites();

    const row = await stored('b1');
    expect(row.data.hold).toMatchObject({ capture: { captureId: 'CAP-1' } });
    expect(row.data.status).toBe('deposit_needs_review');
    expect(getBookingStore().get('b1')).toMatchObject({ status: 'deposit_needs_review', hold: { capture: { captureId: 'CAP-1' } } });
    // Nothing is destroyed: the losing version is kept for whoever reviews it.
    expect(await conflicts()).toEqual([expect.objectContaining({ data: { kind: 'booking', id: 'b1', lost: expect.objectContaining({ status: 'cancelled' }) } })]);
  });

  it('a first save of a record the other instance already created is a conflict too', async () => {
    await otherInstanceSaves('booking', 'b2', booking('b2', 'completed'));
    getBookingStore().save(booking('b2', 'cancelled'));
    await flushWrites();
    expect((await stored('b2')).data.status).toBe('deposit_needs_review');
    expect(await conflicts()).toHaveLength(1);
  });

  it('a flagged booking can be saved again: the conflict settles at the new revision', async () => {
    getBookingStore().save(booking('b3'));
    await flushWrites();
    await otherInstanceSaves('booking', 'b3', booking('b3', 'completed'));
    getBookingStore().save(booking('b3', 'cancelled'));
    await flushWrites();

    const reviewed = getBookingStore().get('b3')!;
    getBookingStore().save({ ...reviewed, status: 'completed' });
    await flushWrites();
    expect((await stored('b3')).data.status).toBe('completed');
    expect(await conflicts()).toHaveLength(1);
  });

  it('a table from before revisions is upgraded at startup, with its data', async () => {
    const old = new PGlite();
    await old.query(`CREATE TABLE records (kind text NOT NULL, id text NOT NULL, data jsonb NOT NULL, seq bigserial, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (kind, id))`);
    await old.query(`INSERT INTO records (kind, id, data) VALUES ('booking', 'b0', $1::jsonb)`, [JSON.stringify(booking('b0', 'completed'))]);
    restartMemory();
    await connectStorage(pg(old));
    expect(getBookingStore().get('b0')).toMatchObject({ status: 'completed' });
    getBookingStore().save(booking('b0', 'refunded'));
    await flushWrites();
    const { rows } = await old.query<{ revision: number }>(`SELECT revision FROM records WHERE id = 'b0'`);
    expect(rows).toEqual([{ revision: 2 }]);
    restartMemory();
    await old.close();
  });

  it('a flow that read the record, then saves after the poller saw a newer version, loses the conflict', async () => {
    getBookingStore().save(booking('f1', 'deposit_held'));
    await flushWrites();
    await withBookingLock('f1', async () => {
      const read = getBookingStore().get('f1')!; // the flow reads, then awaits PayPal...
      await otherInstanceSaves('booking', 'f1', booking('f1', 'completed'));
      await pollChanges(); // ...and the poller sees the other instance's save meanwhile
      getBookingStore().save({ ...read, status: 'cancelled' });
    });
    expect((await stored('f1')).data.status).toBe('deposit_needs_review');
    expect(await conflicts()).toEqual([expect.objectContaining({ data: expect.objectContaining({ lost: expect.objectContaining({ status: 'cancelled' }) }) })]);
    expect(getBookingStore().get('f1')!.status).toBe('deposit_needs_review');
  });

  it('a change held off during a lock arrives when the lock ends', async () => {
    getBookingStore().save(booking('f2', 'deposit_held'));
    await flushWrites();
    await withBookingLock('f2', async () => {
      await otherInstanceSaves('booking', 'f2', booking('f2', 'completed'));
      await pollChanges();
      expect(getBookingStore().get('f2')!.status).toBe('deposit_held');
    });
    expect(getBookingStore().get('f2')!.status).toBe('completed');
    expect(await conflicts()).toEqual([]);
  });

  it('every save of a flow that lost is refused, not just the first', async () => {
    getBookingStore().save(booking('f3', 'deposit_held'));
    await flushWrites();
    await withBookingLock('f3', async () => {
      const read = getBookingStore().get('f3')!;
      await otherInstanceSaves('booking', 'f3', { ...booking('f3', 'completed'), customerName: 'Winner' });
      getBookingStore().save({ ...read, status: 'deposit_pending' });
      await flushWrites();
      getBookingStore().save({ ...read, status: 'cancelled' }); // the flow carries on, unaware
    });
    const row = await stored('f3');
    expect(row.data).toMatchObject({ status: 'deposit_needs_review', customerName: 'Winner' });
    expect(await conflicts()).toHaveLength(1);
  });

  it('two saves queued from the same old copy both lose', async () => {
    const real = pg(db);
    let duringWrite: (() => void) | undefined;
    restartMemory();
    await connectStorage({
      query: async (sql, params) => {
        if (sql.startsWith('INSERT')) {
          const run = duringWrite;
          duringWrite = undefined;
          run?.();
        }
        return real.query(sql, params);
      },
    });
    getBookingStore().save(booking('f4', 'deposit_held'));
    await flushWrites();
    await otherInstanceSaves('booking', 'f4', { ...booking('f4', 'completed'), customerName: 'Winner' });
    // The second save is queued while the first is on its way to Postgres.
    duringWrite = () => getBookingStore().save(booking('f4', 'cancelled'));
    getBookingStore().save(booking('f4', 'deposit_pending'));
    await flushWrites();
    expect((await stored('f4')).data).toMatchObject({ status: 'deposit_needs_review', customerName: 'Winner' });
    expect(await conflicts()).toEqual([expect.objectContaining({ data: expect.objectContaining({ lost: expect.objectContaining({ status: 'cancelled' }) }) })]);
  });

  it('inside a lock, a save queued behind the losing one is dropped too', async () => {
    const real = pg(db);
    let duringWrite: (() => void) | undefined;
    restartMemory();
    await connectStorage({
      query: async (sql, params) => {
        if (sql.startsWith('INSERT')) {
          const run = duringWrite;
          duringWrite = undefined;
          run?.();
        }
        return real.query(sql, params);
      },
    });
    getBookingStore().save(booking('f8', 'deposit_held'));
    await flushWrites();
    await withBookingLock('f8', async () => {
      await otherInstanceSaves('booking', 'f8', { ...booking('f8', 'completed'), customerName: 'Winner' });
      duringWrite = () => getBookingStore().save(booking('f8', 'cancelled'));
      getBookingStore().save(booking('f8', 'deposit_pending'));
      await flushWrites();
    });
    expect((await stored('f8')).data).toMatchObject({ status: 'deposit_needs_review', customerName: 'Winner' });
  });

  it('if keeping the losing version fails, the retry still cannot overwrite the winner', async () => {
    const real = pg(db);
    getBookingStore().save(booking('f5', 'deposit_held'));
    await flushWrites();
    await otherInstanceSaves('booking', 'f5', booking('f5', 'completed'));
    restartMemory();
    let failed = false;
    await connectStorage({
      query: async (sql, params) => {
        if (sql.includes(`VALUES ('conflict'`) && !failed) {
          failed = true;
          throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
        }
        return real.query(sql, params);
      },
    });
    // This copy read revision 2 at startup; rewind it to the older read a stale process would hold.
    await db.query(`UPDATE records SET revision = 3, writer = 'other', updated_at = now(), data = $1::jsonb WHERE id = 'f5'`, [JSON.stringify(booking('f5', 'completed'))]);
    getBookingStore().save(booking('f5', 'cancelled'));
    await flushWrites();
    expect(failed).toBe(true);
    expect((await stored('f5')).data.status).toBe('deposit_needs_review');
    expect(await conflicts()).toHaveLength(1);
  });

  it('a lost answer with a newer save queued is not a conflict: the newer save lands', async () => {
    const real = pg(db);
    let lost = false;
    resetStorage();
    await connectStorage({
      query: async (sql, params) => {
        const result = await real.query(sql, params);
        if (sql.startsWith('INSERT') && !lost) {
          lost = true;
          persist('booking', 'f6', booking('f6', 'completed')); // a newer save while the answer is lost
          throw Object.assign(new Error('Query read timeout'), { code: 'ETIMEDOUT' });
        }
        return result;
      },
    });
    persist('booking', 'f6', booking('f6', 'deposit_held'));
    expect(await flushWrites()).toBe(true);
    expect((await stored('f6')).data.status).toBe('completed');
    expect(await conflicts()).toEqual([]);
  });

  it('a slow database delays a lock by a moment, not for good', async () => {
    getBookingStore().save(booking('f7', 'deposit_held'));
    await flushWrites();
    resetStorage();
    await connectStorage({
      query: (sql) => (sql.includes('WHERE kind = $1') ? new Promise(() => {}) : Promise.resolve({ rows: [] })),
    });
    expect(await withBookingLock('f7', async () => getBookingStore().get('f7')!.status)).toBe('deposit_held');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain('refresh timed out');
  });

  it('only one instance runs a plan: losing the race to mark it stops before any money moves', async () => {
    const real = pg(db);
    const plans = getPlanStore();
    const proposed = plan('p9', 'proposed');
    plans.save({ ...proposed, createdAt: new Date().toISOString(), steps: [{ type: 'void_deposit', bookingId: 'none', why: 'w' }] });
    await flushWrites();
    const { rows } = await db.query<{ data: Plan }>(`SELECT data FROM records WHERE id = 'p9'`);
    restartMemory();
    let raced = false;
    await connectStorage({
      query: async (sql, params) => {
        // The other instance marks the plan just before this one's write reaches Postgres.
        if (sql.startsWith('INSERT') && params?.[1] === 'p9' && !raced) {
          raced = true;
          await otherInstanceSaves('plan', 'p9', { ...rows[0].data, status: 'executing' });
        }
        return real.query(sql, params);
      },
    });
    const voidPayment = vi.fn();
    const deps = {
      bookings: getBookingStore(),
      plans: getPlanStore(),
      audit: getAuditLog(),
      payments: { voidPayment },
      wallet: {},
      payouts: () => ({}),
    } as unknown as ExecuteDeps;
    await expect(approvePlan(deps, 'p9')).rejects.toMatchObject({ code: 'not_proposed', httpStatus: 409 });
    expect(voidPayment).not.toHaveBeenCalled();
    expect(getAuditLog().list()).toEqual([]);
    expect(getPlanStore().get('p9')).toMatchObject({ status: 'executing' });
  });

  it('an instance on the older release, which never counts revisions, is still seen and not overwritten', async () => {
    getBookingStore().save(booking('o1', 'deposit_held'));
    await flushWrites();
    const olderReleaseSaves = (data: Booking) =>
      db.query(
        `INSERT INTO records (kind, id, data) VALUES ('booking', $1, $2::jsonb)
         ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [data.id, JSON.stringify(data)],
      );

    await olderReleaseSaves({ ...booking('o1', 'deposit_held'), customerName: 'Seen' });
    await pollChanges();
    expect(getBookingStore().get('o1')!.customerName).toBe('Seen');

    await olderReleaseSaves({ ...booking('o1', 'completed'), customerName: 'Winner' });
    getBookingStore().save(booking('o1', 'cancelled'));
    await flushWrites();
    expect((await stored('o1')).data).toMatchObject({ status: 'deposit_needs_review', customerName: 'Winner' });
    expect(await conflicts()).toHaveLength(1);
  });

  it('connecting twice keeps the trigger working', async () => {
    await connectStorage(pg(db));
    getBookingStore().save(booking('o2'));
    await flushWrites();
    await db.query(`UPDATE records SET updated_at = now() WHERE id = 'o2'`);
    expect((await stored('o2')).revision).toBe(2);
  });

  it('rejecting a plan another instance already took says so, instead of "rejected"', async () => {
    const real = pg(db);
    getPlanStore().save({ ...plan('p6', 'proposed'), createdAt: new Date().toISOString() });
    await flushWrites();
    const { rows } = await db.query<{ data: Plan }>(`SELECT data FROM records WHERE id = 'p6'`);
    restartMemory();
    let raced = false;
    await connectStorage({
      query: async (sql, params) => {
        if (sql.startsWith('INSERT') && params?.[1] === 'p6' && !raced) {
          raced = true;
          await otherInstanceSaves('plan', 'p6', { ...rows[0].data, status: 'executing' });
        }
        return real.query(sql, params);
      },
    });
    await expect(rejectPlan(getPlanStore(), 'p6')).rejects.toMatchObject({ code: 'not_proposed', httpStatus: 409 });
    expect(getPlanStore().get('p6')).toMatchObject({ status: 'executing' });
  });

  it('a plan left executing is written off once it could no longer be running', async () => {
    getPlanStore().save({ ...plan('p5', 'executing'), decidedAt: new Date().toISOString() });
    await flushWrites();
    restartMemory();
    await connectStorage(pg(db));
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      expect(getPlanStore().get('p5')).toMatchObject({ status: 'executing' });
      vi.advanceTimersByTime(31 * 60 * 1000);
      expect(getPlanStore().get('p5')).toMatchObject({ status: 'failed' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a plan the old instance may still be running is not written off at startup', async () => {
    getPlanStore().save({ ...plan('p7', 'executing'), decidedAt: new Date().toISOString() });
    getPlanStore().save({ ...plan('p8', 'executing'), decidedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    await restart(db);
    expect(getPlanStore().get('p7')).toMatchObject({ status: 'executing' });
    expect(getPlanStore().get('p8')).toMatchObject({ status: 'failed' });
  });

  it('an answer lost to a timeout is not a conflict with ourselves', async () => {
    const real = pg(db);
    let lost = false;
    const flaky: Database = {
      query: async (sql, params) => {
        const result = await real.query(sql, params);
        if (sql.startsWith('INSERT') && !lost) {
          lost = true;
          throw Object.assign(new Error('Query read timeout'), { code: 'ETIMEDOUT' });
        }
        return result;
      },
    };
    resetStorage();
    await connectStorage(flaky);
    persist('booking', 'b4', booking('b4', 'completed'));
    expect(await flushWrites()).toBe(true);
    expect((await stored('b4')).data.status).toBe('completed');
    expect(await conflicts()).toEqual([]);
  });

  it('a money flow starts from the latest version: the lock re-reads the record', async () => {
    getBookingStore().save(booking('b5', 'deposit_held'));
    await flushWrites();
    await otherInstanceSaves('booking', 'b5', booking('b5', 'completed'));
    expect(getBookingStore().get('b5')!.status).toBe('deposit_held');

    const seen = await withBookingLock('b5', async () => getBookingStore().get('b5')!.status);
    expect(seen).toBe('completed');
  });

  it('a save made under the lock after the re-read is not a conflict', async () => {
    getBookingStore().save(booking('b6', 'deposit_held'));
    await flushWrites();
    await otherInstanceSaves('booking', 'b6', booking('b6', 'deposit_pending'));
    await withBookingLock('b6', async () => {
      getBookingStore().save({ ...getBookingStore().get('b6')!, status: 'completed' });
    });
    expect((await stored('b6')).data.status).toBe('completed');
    expect(await conflicts()).toEqual([]);
  });

  it('a slow or failing database does not stop a lock: the flow runs from memory', async () => {
    getBookingStore().save(booking('b7', 'deposit_held'));
    await flushWrites();
    resetStorage();
    await connectStorage({ query: async (sql) => {
      if (sql.includes('WHERE kind = $1')) throw new Error('database down');
      return { rows: [] };
    } });
    expect(await withBookingLock('b7', async () => getBookingStore().get('b7')!.status)).toBe('deposit_held');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain('refresh failed');
  });

  it('a booking the other instance created shows up here, and on the live feed', async () => {
    getBookingStore(); // the store exists, as it does in a running server
    const heard: string[] = [];
    const stop = onBookingChange((b) => heard.push(b.id));
    await otherInstanceSaves('booking', 'new', booking('new', 'deposit_held'));
    await pollChanges();
    stop();
    expect(getBookingStore().get('new')).toMatchObject({ status: 'deposit_held' });
    expect(heard).toEqual(['new']);
  });

  it('a change that lands before the store exists is seeded into it', async () => {
    await otherInstanceSaves('booking', 'early', booking('early', 'deposit_held'));
    await pollChanges();
    expect(getBookingStore().get('early')).toMatchObject({ status: 'deposit_held' });
  });

  it('following never replaces a local save that is still queued', async () => {
    getBookingStore().save(booking('b8', 'deposit_held'));
    await flushWrites();
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const real = pg(db);
    restartMemory();
    await connectStorage({
      query: async (sql, params) => {
        if (sql.startsWith('INSERT')) await gate;
        return real.query(sql, params);
      },
    });
    getBookingStore().save(booking('b8', 'completed'));
    await otherInstanceSaves('booking', 'b8', booking('b8', 'cancelled'));
    await pollChanges();
    expect(getBookingStore().get('b8')!.status).toBe('completed');
    release();
    await flushWrites();
  });

  it('follows audit entries and payouts too, and an own write is not applied twice', async () => {
    getAuditLog().append({ at: 'x', planId: 'mine', stepIndex: 0, action: 'void_deposit', outcome: 'done', why: 'w' });
    await flushWrites();
    await otherInstanceSaves('audit', 'theirs-0', { at: 'y', planId: 'theirs', stepIndex: 0, action: 'void_deposit', outcome: 'done', why: 'w' });
    getPayoutStore();
    await otherInstanceSaves('payout', '2026-11-01', { day: '2026-11-01', state: 'submitted', payoutBatchId: 'B-9', items: [] });
    await pollChanges();
    await pollChanges();
    expect(getAuditLog().list().map((e) => e.planId)).toEqual(['theirs', 'mine']);
    expect(getPayoutStore().get('2026-11-01')).toMatchObject({ payoutBatchId: 'B-9' });
  });

  it('a payout batch that loses a conflict goes to review, so it is checked before anyone pays again', async () => {
    const record = { day: '2026-11-02', state: 'submitting', items: [] } as unknown as PayoutBatchRecord;
    getPayoutStore().save(record);
    await flushWrites();
    await otherInstanceSaves('payout', '2026-11-02', { ...record, state: 'submitted', payoutBatchId: 'B-1' });
    getPayoutStore().save({ ...record, state: 'rejected' });
    await flushWrites();
    expect(getPayoutStore().get('2026-11-02')).toMatchObject({ state: 'needs_review', payoutBatchId: 'B-1' });
  });

  it('a restart keeps revisions, so the next save is not a false conflict', async () => {
    getBookingStore().save(booking('b9', 'deposit_held'));
    await flushWrites();
    await restart(db);
    getBookingStore().save(booking('b9', 'completed'));
    await flushWrites();
    expect(await stored('b9')).toMatchObject({ revision: 2, data: { status: 'completed' } });
    expect(await conflicts()).toEqual([]);
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
        return { rows: sql.startsWith('INSERT') ? [{ revision: 1 }] : [] };
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
        return { rows: sql.startsWith('INSERT') ? [{ revision: 1 }] : [] };
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
        return { rows: sql.startsWith('INSERT') ? [{ revision: 1 }] : [] };
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
    expect(writes.at(-1)!.slice(0, 3)).toEqual(['booking', 'b1', '{"n":2}']);
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
        return { rows: sql.startsWith('INSERT') ? [{ revision: 1 }] : [] };
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
