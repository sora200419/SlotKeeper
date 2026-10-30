import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as copilotRoute } from '@/app/api/copilot/route';
import { GET as auditRoute } from '@/app/api/copilot/audit/route';
import { POST as approveRoute } from '@/app/api/copilot/plans/[id]/approve/route';
import { GET as planRoute } from '@/app/api/copilot/plans/[id]/route';

const TOKEN = 'staff-token-for-tests';
const auth = { Authorization: `Bearer ${TOKEN}` };
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  for (const key of ['__slotkeeperPlans', '__slotkeeperAudit', '__slotkeeperBookings']) {
    (globalThis as Record<string, unknown>)[key] = undefined;
  }
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('STAFF_API_TOKEN', TOKEN);
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  // The approve route builds PayPal controllers; no request is made in these tests.
  vi.stubEnv('NEXT_PUBLIC_PAYPAL_CLIENT_ID', 'test-client-id');
  vi.stubEnv('PAYPAL_CLIENT_SECRET', 'test-secret');
  vi.stubEnv('NEXT_PUBLIC_PAYPAL_ENVIRONMENT', 'sandbox');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('copilot routes', () => {
  it('are all staff-only', async () => {
    const post = (body: unknown) =>
      new Request('http://app.test/api/copilot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await copilotRoute(post({ message: 'hi' }))).status).toBe(401);
    expect((await auditRoute(new Request('http://app.test/api/copilot/audit'))).status).toBe(401);
    expect((await planRoute(new Request('http://app.test'), params('p'))).status).toBe(401);
    expect((await approveRoute(new Request('http://app.test', { method: 'POST' }), params('p'))).status).toBe(401);
  });

  it('reports a missing ANTHROPIC_API_KEY as a config error, and validates the message', async () => {
    const post = (body: unknown) =>
      copilotRoute(new Request('http://app.test/api/copilot', { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify(body) }));
    expect((await post({ message: '' })).status).toBe(400);
    const res = await post({ message: 'Maria is sick' });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'missing_config' });
  });

  it('404s an unknown plan and lists an empty audit log', async () => {
    expect((await planRoute(new Request('http://app.test', { headers: auth }), params('nope'))).status).toBe(404);
    expect((await approveRoute(new Request('http://app.test', { method: 'POST', headers: auth }), params('nope'))).status).toBe(404);
    const audit = await auditRoute(new Request('http://app.test/api/copilot/audit', { headers: auth }));
    expect(await audit.json()).toEqual({ entries: [] });
  });
});
