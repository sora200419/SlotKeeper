import 'server-only';
import { verify, X509Certificate } from 'node:crypto';
import { crc32 } from './crc32';
import { describeTransportError, isNetworkError } from './errors';

/** The request was not signed by PayPal for our webhook. Answer 401; PayPal won't fix it by retrying. */
export class WebhookSignatureError extends Error {
  constructor(
    readonly reason:
      | 'missing_headers'
      | 'unsupported_algorithm'
      | 'untrusted_cert_url'
      | 'invalid_cert'
      | 'bad_signature',
    message: string,
  ) {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

/** Something on our side or the network failed (e.g. the cert download). Answer 503 so PayPal retries. */
export class WebhookRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookRetryableError';
  }
}

/** Downloads a PEM certificate. Only ever called with a URL that passed `trustedCertUrl`. */
export type CertFetcher = (url: URL) => Promise<string>;

const CERT_TIMEOUT_MS = 10_000;
const MAX_CERT_BYTES = 64 * 1024;
const MAX_CACHED_CERTS = 20;

/** PayPal's REST API hosts, which serve the webhook signing certificates. */
const CERT_HOSTS = new Set([
  'api.paypal.com',
  'api-m.paypal.com',
  'api.sandbox.paypal.com',
  'api-m.sandbox.paypal.com',
]);

/**
 * PayPal signs with SHA256withRSA and serves the cert from its own API host. The URL arrives in a
 * request header, so it is attacker-controlled until checked: https on PayPal's API hosts only,
 * no credentials or custom port (otherwise this becomes an SSRF to anything we can reach).
 * Trust in the certificate then rests on TLS to that host; the chain itself is not re-verified.
 */
export function trustedCertUrl(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not a URL at all: treated the same as an untrusted host by the caller.
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
  if (!CERT_HOSTS.has(host)) return undefined;
  return url;
}

export const fetchCertificate: CertFetcher = async (url) => {
  let response: Response;
  try {
    response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(CERT_TIMEOUT_MS) });
  } catch (err) {
    const reason = err instanceof Error && isNetworkError(err) ? describeTransportError(err) : String(err);
    throw new WebhookRetryableError(`Could not download the PayPal webhook certificate: ${reason}`);
  }
  if (!response.ok) {
    throw new WebhookRetryableError(`PayPal webhook certificate download failed (HTTP ${response.status}).`);
  }
  const pem = await response.text();
  if (pem.length > MAX_CERT_BYTES) {
    throw new WebhookRetryableError('PayPal webhook certificate is unexpectedly large.');
  }
  return pem;
};

const cache = globalThis as typeof globalThis & { __slotkeeperWebhookCerts?: Map<string, X509Certificate> };

async function loadCertificate(url: URL, getCert: CertFetcher, now: Date): Promise<X509Certificate> {
  const certs = (cache.__slotkeeperWebhookCerts ??= new Map());
  let cert = certs.get(url.href);
  if (!cert) {
    const pem = await getCert(url);
    try {
      cert = new X509Certificate(pem);
    } catch {
      throw new WebhookSignatureError('invalid_cert', 'The webhook certificate could not be parsed.');
    }
    if (!/CN=[^,\n]*\.paypal\.com(\n|,|$)/.test(cert.subject)) {
      throw new WebhookSignatureError('invalid_cert', 'The webhook certificate was not issued to PayPal.');
    }
    if (certs.size >= MAX_CACHED_CERTS) certs.delete(certs.keys().next().value!);
    certs.set(url.href, cert);
  }
  if (now < new Date(cert.validFrom) || now > new Date(cert.validTo)) {
    certs.delete(url.href);
    throw new WebhookSignatureError('invalid_cert', 'The webhook certificate is not valid at this time.');
  }
  return cert;
}

/**
 * Verifies a PayPal webhook delivery locally (the Server SDK has no webhook support):
 * signature over `transmissionId|transmissionTime|webhookId|crc32(raw body)` with the cert's key.
 * `rawBody` must be the exact bytes received; re-serialised JSON will not verify.
 */
export async function verifyWebhookSignature(options: {
  headers: Headers;
  rawBody: Buffer;
  webhookId: string;
  getCert?: CertFetcher;
  now?: Date;
}): Promise<void> {
  const { headers, rawBody, webhookId, getCert = fetchCertificate, now = new Date() } = options;
  const transmissionId = headers.get('paypal-transmission-id');
  const transmissionTime = headers.get('paypal-transmission-time');
  const signature = headers.get('paypal-transmission-sig');
  const certUrl = headers.get('paypal-cert-url');
  const algorithm = headers.get('paypal-auth-algo');
  if (!transmissionId || !transmissionTime || !signature || !certUrl || !algorithm) {
    throw new WebhookSignatureError('missing_headers', 'PayPal webhook signature headers are missing.');
  }
  if (algorithm !== 'SHA256withRSA') {
    throw new WebhookSignatureError('unsupported_algorithm', `Unsupported webhook signature algorithm ${algorithm}.`);
  }
  const url = trustedCertUrl(certUrl);
  if (!url) {
    throw new WebhookSignatureError('untrusted_cert_url', 'The webhook certificate URL is not a PayPal URL.');
  }
  const cert = await loadCertificate(url, getCert, now);
  const message = `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(rawBody)}`;
  const valid = verify('sha256', Buffer.from(message), cert.publicKey, Buffer.from(signature, 'base64'));
  if (!valid) {
    throw new WebhookSignatureError('bad_signature', 'The webhook signature does not match.');
  }
}
