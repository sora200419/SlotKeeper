import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryBookingStore } from '@/lib/booking/store';
import { createMemoryPayoutStore, type PayoutDeps } from '@/lib/paypal/payouts';
import type { RestTransport } from '@/lib/paypal/rest';

const request = vi.fn();
let currentDeps: PayoutDeps;
vi.mock('@/lib/paypal/payout-deps', () => ({
  getPayoutDeps: () => currentDeps,
  // A fixed day well in the past: the route refuses days that are not over (real clock).
  yesterdayInBusinessZone: () => '2026-01-15',
}));

import { GET as statusRoute } from '@/app/api/payouts/[day]/route';
import { POST as runRoute } from '@/app/api/payouts/route';

const TOKEN = 'staff-token-for-tests';

function post(body?: unknown, auth = true) {
  return runRoute(
    new Request('http://app.test/api/payouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  request.mockReset();
  currentDeps = {
    rest: { request } as unknown as RestTransport,
    bookings: createMemoryBookingStore(),
    payouts: createMemoryPayoutStore(),
    emails: new Map(),
    timeZone: 'UTC',
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('STAFF_API_TOKEN', TOKEN);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/payouts', () => {
  it('is staff-only', async () => {
    expect((await post({}, false)).status).toBe(401);
    expect(request).not.toHaveBeenCalled();
  });

  it('defaults to yesterday (the last finished day) and reports a day with nothing to pay', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ day: '2026-01-15', state: 'nothing_to_pay' });
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a day that is not over yet with 409', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await post({ day: future });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'day_not_over' });
  });

  it('rejects a bad day with 400', async () => {
    expect((await post({ day: 20261101 })).status).toBe(400);
    const res = await post({ day: 'yesterday' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_date' });
  });
});

describe('GET /api/payouts/[day]', () => {
  it('is staff-only and 404s for a day without a batch', async () => {
    const day = { params: Promise.resolve({ day: '2026-11-01' }) };
    expect((await statusRoute(new Request('http://app.test/api/payouts/2026-11-01'), day)).status).toBe(401);
    const res = await statusRoute(
      new Request('http://app.test/api/payouts/2026-11-01', { headers: { Authorization: `Bearer ${TOKEN}` } }),
      day,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });
});
