import { Environment } from '@paypal/paypal-server-sdk';
import { describe, expect, it } from 'vitest';
import { PayPalConfigError, readPayPalSettings } from '@/lib/paypal/config';

const base = {
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
};

describe('readPayPalSettings', () => {
  it('defaults to sandbox and a finite timeout', () => {
    const settings = readPayPalSettings(base);
    expect(settings.environment).toBe(Environment.Sandbox);
    expect(settings.timeoutMs).toBe(15_000);
    expect(settings.clientId).toBe('test-client-id');
  });

  it('lists every missing variable', () => {
    try {
      readPayPalSettings({});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PayPalConfigError);
      expect((err as PayPalConfigError).missing).toEqual([
        'NEXT_PUBLIC_PAYPAL_CLIENT_ID',
        'PAYPAL_CLIENT_SECRET',
      ]);
    }
  });

  it('treats blank values as missing', () => {
    expect(() => readPayPalSettings({ ...base, PAYPAL_CLIENT_SECRET: '   ' })).toThrow(
      /PAYPAL_CLIENT_SECRET/,
    );
  });

  it('blocks production unless PAYPAL_ALLOW_PRODUCTION=true', () => {
    expect(() =>
      readPayPalSettings({ ...base, NEXT_PUBLIC_PAYPAL_ENVIRONMENT: 'production' }),
    ).toThrow(/PAYPAL_ALLOW_PRODUCTION/);
    expect(() =>
      readPayPalSettings({
        ...base,
        NEXT_PUBLIC_PAYPAL_ENVIRONMENT: 'production',
        PAYPAL_ALLOW_PRODUCTION: 'yes',
      }),
    ).toThrow(PayPalConfigError);
    expect(
      readPayPalSettings({
        ...base,
        NEXT_PUBLIC_PAYPAL_ENVIRONMENT: 'Production',
        PAYPAL_ALLOW_PRODUCTION: 'true',
      }).environment,
    ).toBe(Environment.Production);
  });

  it('rejects unknown environments', () => {
    expect(() => readPayPalSettings({ ...base, NEXT_PUBLIC_PAYPAL_ENVIRONMENT: 'live' })).toThrow(
      PayPalConfigError,
    );
  });

  it('rejects a zero, negative, non-numeric or over-60-second timeout', () => {
    for (const value of ['0', '-5', 'abc', '1.5', '60001']) {
      expect(() => readPayPalSettings({ ...base, PAYPAL_TIMEOUT_MS: value })).toThrow(
        /PAYPAL_TIMEOUT_MS/,
      );
    }
    expect(readPayPalSettings({ ...base, PAYPAL_TIMEOUT_MS: '8000' }).timeoutMs).toBe(8000);
    expect(readPayPalSettings({ ...base, PAYPAL_TIMEOUT_MS: '60000' }).timeoutMs).toBe(60000);
  });
});
