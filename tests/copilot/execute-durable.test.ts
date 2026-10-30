import { afterEach, describe, expect, it, vi } from 'vitest';

const { flushWrites } = vi.hoisted(() => ({ flushWrites: vi.fn() }));
vi.mock('@/lib/storage/records', async (original) => ({
  ...(await original<typeof import('@/lib/storage/records')>()),
  flushWrites,
}));

import { createMemoryBookingStore } from '@/lib/booking/store';
import { approvePlan, type ExecuteDeps } from '@/lib/copilot/execute';
import { createMemoryAuditLog, createMemoryPlanStore, type Plan } from '@/lib/copilot/plan';

const NOW = new Date('2026-11-01T12:00:00.000Z');

function setup() {
  const plans = createMemoryPlanStore();
  const plan: Plan = {
    id: 'p1',
    request: 'r',
    summary: 's',
    status: 'proposed',
    createdAt: NOW.toISOString(),
    steps: [{ type: 'void_deposit', bookingId: 'b1', why: 'w' }],
  };
  plans.save(plan);
  const voidPayment = vi.fn();
  const deps = {
    bookings: createMemoryBookingStore(),
    plans,
    audit: createMemoryAuditLog(),
    payments: { voidPayment },
    wallet: {},
    payouts: () => ({}),
  } as unknown as ExecuteDeps;
  return { deps, plans, voidPayment };
}

afterEach(() => {
  flushWrites.mockReset();
  vi.restoreAllMocks();
});

describe('approvePlan and the database', () => {
  it('runs nothing while "executing" cannot be saved, and the plan can be approved again', async () => {
    flushWrites.mockResolvedValue(false);
    const { deps, plans, voidPayment } = setup();
    await expect(approvePlan(deps, 'p1', NOW)).rejects.toMatchObject({ code: 'storage_unavailable', httpStatus: 503 });
    expect(voidPayment).not.toHaveBeenCalled();
    expect(plans.get('p1')).toMatchObject({ status: 'proposed' });
    expect(deps.audit.list()).toEqual([]);
  });

  it('runs once the mark is saved', async () => {
    flushWrites.mockResolvedValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, plans } = setup();
    await approvePlan(deps, 'p1', NOW);
    // The booking does not exist, so the step fails: what matters is that it was attempted and audited.
    expect(deps.audit.list()).toHaveLength(1);
    expect(plans.get('p1')).toMatchObject({ status: 'failed' });
  });
});
