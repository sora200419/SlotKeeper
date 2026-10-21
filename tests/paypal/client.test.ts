import { Environment } from '@paypal/paypal-server-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildClientConfiguration, createPayPalClient } from '@/lib/paypal/client';

const settings = {
  environment: Environment.Sandbox,
  clientId: 'id',
  clientSecret: 'secret',
  timeoutMs: 12_000,
};

describe('buildClientConfiguration', () => {
  it('sets an explicit timeout and only retries idempotent methods', () => {
    const config = buildClientConfiguration(settings);
    expect(config.timeout).toBe(12_000);
    expect(config.environment).toBe(Environment.Sandbox);
    expect(config.httpClientOptions?.timeout).toBe(12_000);
    expect(config.httpClientOptions?.retryConfig?.httpMethodsToRetry).toEqual(['GET', 'PUT']);
    expect(config.httpClientOptions?.retryConfig?.maxNumberOfRetries).toBeGreaterThan(0);
    expect(config.httpClientOptions?.retryConfig?.maximumRetryWaitTime).toBeGreaterThan(0);
    expect(config.clientCredentialsAuthCredentials?.oAuthClientId).toBe('id');
  });
});

describe('createPayPalClient', () => {
  it('builds a client with the client-credentials token manager', () => {
    const client = createPayPalClient(settings);
    expect(client.clientCredentialsAuthManager).toBeDefined();
  });
});

describe('getPayPalClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the same long-lived client on every call', async () => {
    vi.stubEnv('NEXT_PUBLIC_PAYPAL_CLIENT_ID', 'id');
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'secret');
    vi.resetModules();
    const { getPayPalClient } = await import('@/lib/paypal/client');
    expect(getPayPalClient()).toBe(getPayPalClient());
  });
});
