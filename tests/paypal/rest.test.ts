import { describe, expect, it, vi } from 'vitest';
import { createRestTransport, PayPalRestError, PayPalUnreachableError } from '@/lib/paypal/rest';

type Reply = Response | Error;

function transport(...replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected fetch');
    if (reply instanceof Error) throw reply;
    return reply;
  }) as unknown as typeof fetch;
  const getToken = vi.fn(async (force: boolean) => (force ? 'fresh-token' : 'cached-token'));
  const rest = createRestTransport({ baseUrl: 'https://api-m.sandbox.paypal.com', getToken, timeoutMs: 5000, fetchFn });
  return { rest, calls, getToken };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('createRestTransport', () => {
  it('sends the bearer token, JSON body and PayPal-Request-Id', async () => {
    const { rest, calls } = transport(json(201, { ok: true }));
    expect(await rest.request({ method: 'POST', path: '/v1/payments/payouts', body: { a: 1 }, requestId: 'req-1' })).toEqual({ ok: true });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe('https://api-m.sandbox.paypal.com/v1/payments/payouts');
    expect(calls[0].init.method).toBe('POST');
    expect(headers.Authorization).toBe('Bearer cached-token');
    expect(headers['PayPal-Request-Id']).toBe('req-1');
    expect(headers['Content-Type']).toBe('application/json');
    expect(calls[0].init.body).toBe('{"a":1}');
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('refreshes the token once after a 401 and repeats the call', async () => {
    const { rest, calls, getToken } = transport(json(401, { error: 'invalid_token' }), json(200, { ok: 1 }));
    await rest.request({ method: 'GET', path: '/v1/payments/payouts/B1' });
    expect(getToken.mock.calls).toEqual([[false], [true]]);
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer fresh-token');
  });

  it('turns an error answer into PayPalRestError with name, issue and debug id', async () => {
    const { rest } = transport(
      json(422, { name: 'UNPROCESSABLE_ENTITY', message: 'nope', debug_id: 'dbg-1', details: [{ issue: 'INSUFFICIENT_FUNDS' }] }),
    );
    const err = (await rest
      .request({ method: 'POST', path: '/v1/payments/payouts', body: {} })
      .then(() => undefined, (e: unknown) => e)) as PayPalRestError;
    expect(err).toBeInstanceOf(PayPalRestError);
    expect(err.failure).toEqual({ status: 422, name: 'UNPROCESSABLE_ENTITY', issue: 'INSUFFICIENT_FUNDS', description: 'nope', debugId: 'dbg-1' });
  });

  it('reports network failures and unreadable answers as unreachable, without the token', async () => {
    const { rest } = transport(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }),
      new Response('<html>bad gateway</html>', { status: 200 }),
    );
    const network = (await rest
      .request({ method: 'GET', path: '/v1/payments/payouts/B1?page_size=5' })
      .then(() => undefined, (e: unknown) => e)) as PayPalUnreachableError;
    expect(network).toBeInstanceOf(PayPalUnreachableError);
    expect(network.message).not.toContain('token');
    expect(network.message).not.toContain('page_size');
    await expect(rest.request({ method: 'GET', path: '/x' })).rejects.toBeInstanceOf(PayPalUnreachableError);
  });
});
