import { ApiError, Environment } from '@paypal/paypal-server-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkPayPalCredentials,
  createCachedCredentialCheck,
  type CredentialCheck,
  type TokenSource,
} from '@/lib/paypal/health';

function source(fetchToken: () => Promise<{ expiresIn?: bigint }>): TokenSource {
  return { clientCredentialsAuthManager: { fetchToken } };
}

function apiError(statusCode: number, result?: unknown, headers: Record<string, string> = {}) {
  const context = {
    request: { method: 'POST', url: 'https://api-m.sandbox.paypal.com/v1/oauth2/token' },
    response: { statusCode, headers, body: JSON.stringify(result ?? {}) },
  } as unknown as ConstructorParameters<typeof ApiError>[0];
  const err = new ApiError(context, `HTTP ${statusCode}`);
  err.result = result as never;
  return err;
}

function failing(err: unknown): TokenSource {
  return source(async () => {
    throw err;
  });
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('checkPayPalCredentials', () => {
  it('reports success without exposing the token', async () => {
    const result = await checkPayPalCredentials(
      source(async () => ({ accessToken: 'SECRET-TOKEN', expiresIn: 32400n }) as never),
      Environment.Sandbox,
    );
    expect(result).toEqual({
      ok: true,
      environment: Environment.Sandbox,
      tokenExpiresInSeconds: 32400,
    });
    expect(JSON.stringify(result)).not.toContain('SECRET-TOKEN');
  });

  it('maps a 401 to invalid_credentials with the debug id', async () => {
    const result = await checkPayPalCredentials(
      failing(
        apiError(
          401,
          { error: 'invalid_client', error_description: 'Client Authentication failed' },
          { 'paypal-debug-id': 'abc123' },
        ),
      ),
      Environment.Sandbox,
    );
    expect(result).toMatchObject({
      ok: false,
      reason: 'invalid_credentials',
      status: 401,
      debugId: 'abc123',
    });
    expect(result.ok === false && result.detail).toContain(
      'invalid_client: Client Authentication failed',
    );
  });

  it('maps a 400 invalid_client to invalid_credentials', async () => {
    const result = await checkPayPalCredentials(
      failing(apiError(400, { error: 'invalid_client' })),
      Environment.Sandbox,
    );
    expect(result).toMatchObject({ ok: false, reason: 'invalid_credentials', status: 400 });
  });

  it('does not blame credentials for other 400s', async () => {
    const result = await checkPayPalCredentials(
      failing(apiError(400, { error: 'unsupported_grant_type' })),
      Environment.Sandbox,
    );
    expect(result).toMatchObject({ ok: false, reason: 'paypal_error', status: 400 });
    expect(result.ok === false && result.detail).toContain('unsupported_grant_type');
  });

  it('maps other PayPal statuses to paypal_error', async () => {
    const result = await checkPayPalCredentials(failing(apiError(503)), Environment.Sandbox);
    expect(result).toMatchObject({ ok: false, reason: 'paypal_error', status: 503 });
  });

  it('maps transport failures to network_error and logs them', async () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND api-m.sandbox.paypal.com'), {
      code: 'ENOTFOUND',
    });
    const result = await checkPayPalCredentials(failing(err), Environment.Sandbox);
    expect(result).toMatchObject({ ok: false, reason: 'network_error' });
    expect(result.ok === false && result.detail).toContain('ENOTFOUND');
    expect(console.error).toHaveBeenCalled();
  });

  it('re-throws programming errors instead of calling them network errors, as a sanitized error', async () => {
    await expect(
      checkPayPalCredentials(failing(new TypeError('x is not a function')), Environment.Sandbox),
    ).rejects.toThrow('TypeError: x is not a function');
  });

  it('turns a TLS failure carrying the Basic auth header into a clean network_error, leaking nothing', async () => {
    // Shape of the real failure: an axios error whose request config holds the client secret.
    const leaky = Object.assign(new Error('unable to verify the first certificate'), {
      isAxiosError: true,
      config: { headers: { Authorization: 'Basic TOP-SECRET-CREDENTIALS' } },
      request: { _header: 'POST /v1/oauth2/token\r\nAuthorization: Basic TOP-SECRET-CREDENTIALS' },
      cause: Object.assign(new Error('unable to verify the first certificate'), {
        code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      }),
    });

    const result = await checkPayPalCredentials(failing(leaky), Environment.Sandbox);

    expect(result).toMatchObject({ ok: false, reason: 'network_error' });
    expect(result.ok === false && result.detail).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(result.ok === false && result.detail).toContain('NODE_OPTIONS=--use-system-ca');
    expect(JSON.stringify(result)).not.toContain('TOP-SECRET');
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain('TOP-SECRET');
  });

  it('treats any raw axios error as a transport failure instead of re-throwing it', async () => {
    const axiosLike = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      config: { headers: { Authorization: 'Basic TOP-SECRET-CREDENTIALS' } },
    });
    const result = await checkPayPalCredentials(failing(axiosLike), Environment.Sandbox);
    expect(result).toMatchObject({ ok: false, reason: 'network_error' });
    expect(JSON.stringify(result)).not.toContain('TOP-SECRET');
  });

  it('R9: a response-validation error carrying the Authorization header leaks nothing', async () => {
    // Shape of the real SDK error: it keeps the request, including the Basic auth header.
    const validation = Object.assign(new Error('Invalid response body.'), {
      name: 'ResponseValidationError',
      request: { headers: { Authorization: 'Basic SECRETVALUE123' } },
    });

    const caught = await checkPayPalCredentials(failing(validation), Environment.Sandbox).catch(
      (e: unknown) => e,
    );

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('ResponseValidationError');
    expect(String((caught as Error).stack)).not.toContain('SECRETVALUE123');
    expect(JSON.stringify(caught)).not.toContain('SECRETVALUE123');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('SECRETVALUE123');
  });

  it('handles a token without expires_in', async () => {
    const result = await checkPayPalCredentials(source(async () => ({})), Environment.Sandbox);
    expect(result).toMatchObject({ ok: true, tokenExpiresInSeconds: null });
  });
});

describe('createCachedCredentialCheck', () => {
  const okResult: CredentialCheck = {
    ok: true,
    environment: Environment.Sandbox,
    tokenExpiresInSeconds: 100,
  };

  it('reuses one result within the TTL and refreshes after it', async () => {
    let clock = 1_000;
    const check = vi.fn(async () => okResult);
    const cached = createCachedCredentialCheck(check, 60_000, () => clock);

    await cached();
    await cached();
    clock += 59_999;
    await cached();
    expect(check).toHaveBeenCalledTimes(1);

    clock += 2;
    await cached();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight request between concurrent callers', async () => {
    const check = vi.fn(async () => okResult);
    const cached = createCachedCredentialCheck(check, 60_000, () => 0);
    await Promise.all([cached(), cached(), cached()]);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('does not cache a thrown error', async () => {
    const check = vi
      .fn<() => Promise<CredentialCheck>>()
      .mockRejectedValueOnce(new TypeError('bug'))
      .mockResolvedValueOnce(okResult);
    const cached = createCachedCredentialCheck(check, 60_000, () => 0);
    await expect(cached()).rejects.toThrow('bug');
    await expect(cached()).resolves.toEqual(okResult);
    expect(check).toHaveBeenCalledTimes(2);
  });
});
