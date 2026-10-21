import { ApiError } from '@paypal/paypal-server-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchToken = vi.fn();
vi.mock('@/lib/paypal/client', () => ({
  getPayPalClient: () => ({ clientCredentialsAuthManager: { fetchToken } }),
}));

async function loadRoute() {
  // Fresh module per test so the route's result cache starts empty.
  vi.resetModules();
  return import('@/app/api/health/route');
}

beforeEach(() => {
  fetchToken.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('NEXT_PUBLIC_PAYPAL_CLIENT_ID', 'test-client-id');
  vi.stubEnv('PAYPAL_CLIENT_SECRET', 'test-client-secret');
  vi.stubEnv('NEXT_PUBLIC_PAYPAL_ENVIRONMENT', 'sandbox');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('GET /api/health', () => {
  it('returns 500 missing_config and never calls PayPal when credentials are missing', async () => {
    vi.stubEnv('PAYPAL_CLIENT_SECRET', '');
    const { GET } = await loadRoute();
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      ok: false,
      reason: 'missing_config',
      missing: ['PAYPAL_CLIENT_SECRET'],
    });
    expect(fetchToken).not.toHaveBeenCalled();
  });

  it('returns 200 when the token request succeeds', async () => {
    fetchToken.mockResolvedValue({ accessToken: 'SECRET-TOKEN', expiresIn: 32400n });
    const { GET } = await loadRoute();
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, environment: 'Sandbox', tokenExpiresInSeconds: 32400 });
    expect(JSON.stringify(body)).not.toContain('SECRET-TOKEN');
  });

  it('returns 502 when PayPal rejects the credentials', async () => {
    const context = {
      request: { method: 'POST', url: 'https://api-m.sandbox.paypal.com/v1/oauth2/token' },
      response: { statusCode: 401, headers: {}, body: '{}' },
    } as unknown as ConstructorParameters<typeof ApiError>[0];
    fetchToken.mockRejectedValue(new ApiError(context, 'HTTP 401'));
    const { GET } = await loadRoute();
    const res = await GET();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, reason: 'invalid_credentials' });
  });

  it('asks PayPal for a token at most once per cache window', async () => {
    fetchToken.mockResolvedValue({ accessToken: 't', expiresIn: 100n });
    const { GET } = await loadRoute();
    await GET();
    await GET();
    await GET();
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });
});
