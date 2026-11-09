import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/mcp/route';

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://app.test/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  (globalThis as { __slotkeeperBookings?: unknown }).__slotkeeperBookings = undefined;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('APP_URL', 'https://slotkeeper.test');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('/api/mcp', () => {
  it('answers an MCP initialize over Streamable HTTP (stateless, JSON)', async () => {
    const res = await POST(
      rpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'slotkeeper' } } });
  });

  it('lists the tools to a client', async () => {
    const res = await POST(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.tools.map((t: { name: string }) => t.name)).toContain('hold_slot');
  });

  it('refuses GET (no server stream in stateless mode) and oversized bodies', async () => {
    expect(GET().status).toBe(405);
    const big = new Request('http://app.test/api/mcp', { method: 'POST', headers: { 'content-length': String(1024 * 1024) }, body: '{}' });
    expect((await POST(big)).status).toBe(413);
  });

  it('R4: a chunked body without Content-Length is cut off at the limit, not read to the end', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(16 * 1024));
      },
    });
    const res = await POST(new Request('http://app.test/api/mcp', { method: 'POST', body: endless, duplex: 'half' } as RequestInit));
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(10);
  });

  it('R7: an internal failure is a generic JSON-RPC error, with no details', async () => {
    vi.stubEnv('BUSINESS_TIME_ZONE', 'Mars/Olympus');
    const res = await POST(rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  });
});

// Live test 6.7 (11-09): 11 holds from one machine in 10 minutes all succeeded, because the route keyed the limit on
// the last X-Forwarded-For entry, a Cloudflare hop that changes per request. These go through the route with the
// headers Render sends, which the injected-key test in tests/agent/mcp.test.ts never exercised.
describe('/api/mcp hold_slot rate limit, keyed as on Render', () => {
  // 2026-11-05 08:00 in Los Angeles. Haircuts are 45 minutes with Maria; hourly starts from 9:00 never overlap.
  const NOW = new Date('2026-11-05T16:00:00Z');
  const STARTS = [17, 18, 19, 20, 21, 22].map((h) => `2026-11-06T${h}:00:00.000Z`);

  async function hold(index: number, headers: Record<string, string>) {
    const res = await POST(
      rpc(
        {
          jsonrpc: '2.0',
          id: index,
          method: 'tools/call',
          params: { name: 'hold_slot', arguments: { serviceId: 'haircut', startsAt: STARTS[index], customerName: 'Rate Test' } },
        },
        headers,
      ),
    );
    expect(res.status).toBe(200);
    const result = (await res.json()).result as { content: Array<{ text: string }>; isError?: boolean };
    return { isError: result.isError === true, text: result.content[0].text };
  }

  beforeEach(() => {
    (globalThis as { __slotkeeperHoldLimiter?: unknown }).__slotkeeperHoldLimiter = undefined;
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    vi.stubEnv('BUSINESS_TIME_ZONE', 'America/Los_Angeles');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts one client once, although the last X-Forwarded-For entry (a Cloudflare hop) differs on every request', async () => {
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await hold(i, { 'cf-connecting-ip': '175.141.10.20', 'x-forwarded-for': `175.141.10.20, 104.23.${i}.9` }));
    }
    expect(results.slice(0, 5).every((r) => !r.isError)).toBe(true);
    expect(results[5].isError).toBe(true);
    expect(results[5].text).toContain('rate_limited');
  });

  it('keeps a separate count per Cloudflare address: another client still holds after the first used its 5', async () => {
    for (let i = 0; i < 5; i++) expect((await hold(i, { 'cf-connecting-ip': '175.141.10.20' })).isError).toBe(false);
    expect((await hold(5, { 'cf-connecting-ip': '198.51.100.7' })).isError).toBe(false);
  });

  it('falls back to the last X-Forwarded-For entry without the Cloudflare header (local runs)', async () => {
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await hold(i, { 'x-forwarded-for': '203.0.113.1' }));
    expect(results[5].isError).toBe(true);
    expect(results[5].text).toContain('rate_limited');
  });
});
