import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/mcp/route';

const rpc = (body: unknown) =>
  new Request('http://app.test/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
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
