import { sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crc32 } from '@/lib/paypal/crc32';
import { makeTestCert } from '../helpers/test-cert';
import {
  fetchCertificate,
  trustedCertUrl,
  verifyWebhookSignature,
  WebhookRetryableError,
} from '@/lib/paypal/webhook-signature';

// Throwaway certificates built in memory per run; no private key is stored in the repository.
const VALIDITY = { notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2049-12-31T00:00:00Z') };
const paypal = makeTestCert({ commonName: 'messageverificationcerts.sandbox.paypal.com', ...VALIDITY });
const other = makeTestCert({ commonName: 'evil.example.com', ...VALIDITY });
const PAYPAL_CERT = paypal.pem;
const PAYPAL_KEY: KeyObject = paypal.privateKey;
const OTHER_CERT = other.pem;
const OTHER_KEY: KeyObject = other.privateKey;

const NOW = new Date('2026-11-01T00:00:00.000Z');
const WEBHOOK_ID = 'WH-TEST-123';
const CERT_URL = 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test';
const BODY = Buffer.from('{"id":"WH-EVT-1","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"CAP-1"}}');

function signedHeaders(options: { body?: Buffer; webhookId?: string; key?: KeyObject; certUrl?: string } = {}) {
  const transmissionId = 'tx-1';
  const time = '2026-11-01T00:00:00Z';
  const message = `${transmissionId}|${time}|${options.webhookId ?? WEBHOOK_ID}|${crc32(options.body ?? BODY)}`;
  return new Headers({
    'paypal-transmission-id': transmissionId,
    'paypal-transmission-time': time,
    'paypal-transmission-sig': sign('sha256', Buffer.from(message), options.key ?? PAYPAL_KEY).toString('base64'),
    'paypal-cert-url': options.certUrl ?? CERT_URL,
    'paypal-auth-algo': 'SHA256withRSA',
  });
}

beforeEach(() => {
  (globalThis as { __slotkeeperWebhookCerts?: unknown }).__slotkeeperWebhookCerts = undefined;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('crc32', () => {
  // Known CRC-32 (IEEE) vectors; hard-coded so the test runs on Node versions without zlib.crc32.
  it.each([
    ['', 0],
    ['a', 0xe8b7be43],
    ['123456789', 0xcbf43926],
    ['The quick brown fox jumps over the lazy dog', 0x414fa339],
  ])('crc32(%j) = %i', (input, expected) => {
    expect(crc32(Buffer.from(input))).toBe(expected);
  });
});

describe('trustedCertUrl', () => {
  it.each([
    'https://api.paypal.com/v1/notifications/certs/CERT-1',
    'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
    'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1',
  ])('accepts %s', (url) => {
    expect(trustedCertUrl(url)?.href).toBe(url);
  });

  it.each([
    'http://api.paypal.com/cert',
    'https://evil.example.com/cert',
    'https://paypal.com.evil.example/cert',
    'https://evilpaypal.com/cert',
    'https://www.paypal.com/cert',
    'https://uploads.paypal.com/cert',
    'https://user:pass@api.paypal.com/cert',
    'https://api.paypal.com:8443/cert',
    'file:///etc/passwd',
    'not a url',
  ])('rejects %s', (url) => {
    expect(trustedCertUrl(url)).toBeUndefined();
  });
});

describe('verifyWebhookSignature', () => {
  it('accepts a correctly signed delivery and caches the certificate', async () => {
    const getCert = vi.fn(async (_url: URL) => PAYPAL_CERT);
    await verifyWebhookSignature({ headers: signedHeaders(), rawBody: BODY, webhookId: WEBHOOK_ID, getCert, now: NOW });
    await verifyWebhookSignature({ headers: signedHeaders(), rawBody: BODY, webhookId: WEBHOOK_ID, getCert, now: NOW });
    expect(getCert).toHaveBeenCalledTimes(1);
    expect(getCert.mock.calls[0][0].href).toBe(CERT_URL);
  });

  it('rejects a body changed after signing', async () => {
    const tampered = Buffer.from(BODY.toString().replace('CAP-1', 'CAP-2'));
    await expect(
      verifyWebhookSignature({
        headers: signedHeaders(),
        rawBody: tampered,
        webhookId: WEBHOOK_ID,
        getCert: async () => PAYPAL_CERT,
        now: NOW,
      }),
    ).rejects.toMatchObject({ name: 'WebhookSignatureError', reason: 'bad_signature' });
  });

  it('rejects a delivery signed for another webhook id', async () => {
    await expect(
      verifyWebhookSignature({
        headers: signedHeaders({ webhookId: 'WH-SOMEONE-ELSE' }),
        rawBody: BODY,
        webhookId: WEBHOOK_ID,
        getCert: async () => PAYPAL_CERT,
        now: NOW,
      }),
    ).rejects.toMatchObject({ reason: 'bad_signature' });
  });

  it('rejects a signature made with a key that is not the certificate\'s', async () => {
    await expect(
      verifyWebhookSignature({
        headers: signedHeaders({ key: OTHER_KEY }),
        rawBody: BODY,
        webhookId: WEBHOOK_ID,
        getCert: async () => PAYPAL_CERT,
        now: NOW,
      }),
    ).rejects.toMatchObject({ reason: 'bad_signature' });
  });

  it('rejects a certificate that was not issued to a paypal.com name', async () => {
    await expect(
      verifyWebhookSignature({
        headers: signedHeaders({ key: OTHER_KEY }),
        rawBody: BODY,
        webhookId: WEBHOOK_ID,
        getCert: async () => OTHER_CERT,
        now: NOW,
      }),
    ).rejects.toMatchObject({ reason: 'invalid_cert' });
  });

  it('rejects a certificate outside its validity period', async () => {
    await expect(
      verifyWebhookSignature({
        headers: signedHeaders(),
        rawBody: BODY,
        webhookId: WEBHOOK_ID,
        getCert: async () => PAYPAL_CERT,
        now: new Date('2020-01-01T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ reason: 'invalid_cert' });
  });

  it('never downloads from an untrusted certificate URL', async () => {
    const getCert = vi.fn(async () => PAYPAL_CERT);
    await expect(
      verifyWebhookSignature({
        headers: signedHeaders({ certUrl: 'https://169.254.169.254/latest/meta-data' }),
        rawBody: BODY,
        webhookId: WEBHOOK_ID,
        getCert,
        now: NOW,
      }),
    ).rejects.toMatchObject({ reason: 'untrusted_cert_url' });
    expect(getCert).not.toHaveBeenCalled();
  });

  it('rejects missing headers and other algorithms', async () => {
    const headers = signedHeaders();
    headers.delete('paypal-transmission-sig');
    await expect(
      verifyWebhookSignature({ headers, rawBody: BODY, webhookId: WEBHOOK_ID, getCert: async () => PAYPAL_CERT }),
    ).rejects.toMatchObject({ reason: 'missing_headers' });

    const sha1 = signedHeaders();
    sha1.set('paypal-auth-algo', 'SHA1withRSA');
    await expect(
      verifyWebhookSignature({ headers: sha1, rawBody: BODY, webhookId: WEBHOOK_ID, getCert: async () => PAYPAL_CERT }),
    ).rejects.toMatchObject({ reason: 'unsupported_algorithm' });
  });
});

describe('fetchCertificate', () => {
  it('returns the PEM and refuses redirects', async () => {
    const fetchMock = vi.fn(async (_url: URL, _init?: RequestInit) => new Response(PAYPAL_CERT, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchCertificate(new URL(CERT_URL))).toBe(PAYPAL_CERT);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('turns HTTP and network failures into retryable errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    await expect(fetchCertificate(new URL(CERT_URL))).rejects.toBeInstanceOf(WebhookRetryableError);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      }),
    );
    await expect(fetchCertificate(new URL(CERT_URL))).rejects.toThrow(/Could not download/);
  });
});
