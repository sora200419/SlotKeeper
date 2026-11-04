import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runCopilot = vi.fn();
// Only the model call is replaced: createCopilotModel stays real, so a missing key still fails as it does live.
vi.mock('@/lib/copilot/copilot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/copilot/copilot')>()),
  runCopilot: (...args: unknown[]) => runCopilot(...args),
}));

import { POST as copilotRoute } from '@/app/api/copilot/route';

const TOKEN = 'staff-token-for-tests';
const post = (message = 'Who is booked tomorrow?') =>
  copilotRoute(
    new Request('http://app.test/api/copilot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ message }),
    }),
  );

beforeEach(() => {
  for (const key of ['__slotkeeperBookings', '__slotkeeperPlans', '__slotkeeperCopilotGate']) {
    (globalThis as Record<string, unknown>)[key] = undefined;
  }
  runCopilot.mockReset();
  runCopilot.mockResolvedValue({ reply: 'ok' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('STAFF_API_TOKEN', TOKEN);
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-key-not-real');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/copilot daily limit', () => {
  it('serves COPILOT_DAILY_LIMIT requests, then answers 429 without calling the model', async () => {
    vi.stubEnv('COPILOT_DAILY_LIMIT', '2');
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    const refused = await post();
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: 'rate_limited', message: expect.stringContaining('2 requests per 24 hours') });
    expect(runCopilot).toHaveBeenCalledTimes(2);
  });

  it('does not use up a request when the API key is missing or the message is invalid', async () => {
    vi.stubEnv('COPILOT_DAILY_LIMIT', '1');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect((await post()).status).toBe(500);
    expect((await post()).status).toBe(500);
    expect((await post('')).status).toBe(400);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-key-not-real');
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429);
  });

  it('reports a bad COPILOT_DAILY_LIMIT as a config error instead of ignoring it', async () => {
    vi.stubEnv('COPILOT_DAILY_LIMIT', 'lots');
    const res = await post();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'missing_config', message: expect.stringContaining('COPILOT_DAILY_LIMIT') });
    expect(runCopilot).not.toHaveBeenCalled();
  });
});
