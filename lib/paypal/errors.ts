import 'server-only';
import { ApiError } from '@paypal/paypal-server-sdk';

/** Transport-level failure codes from Node / axios; anything else is a bug, not a network issue. */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ERR_NETWORK',
  'ERR_CANCELED',
]);

/** TLS certificate failures, e.g. antivirus or a corporate proxy re-signing HTTPS traffic. */
const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** The error code, looking through `cause` (axios and fetch wrap the socket error). */
export function errorCode(err: unknown): string | undefined {
  for (let current: unknown = err, depth = 0; current && depth < 3; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isTlsError(err: unknown): boolean {
  const code = errorCode(err);
  return code !== undefined && TLS_ERROR_CODES.has(code);
}

/**
 * Any failure below the HTTP response: sockets, DNS, TLS, timeouts, and every raw axios error.
 * These must never be re-thrown as-is: an axios error carries the request config, including the
 * `Authorization: Basic <client id:secret>` header, and an unhandled one gets printed in full.
 */
export function isNetworkError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  if ((err as { isAxiosError?: unknown }).isAxiosError === true) return true;
  if (err.name === 'AbortError') return true;
  const code = errorCode(err);
  return code !== undefined && (NETWORK_ERROR_CODES.has(code) || TLS_ERROR_CODES.has(code));
}

/**
 * Re-throwable replacement for an SDK error we don't otherwise handle. SDK errors can carry the
 * request (including the Authorization header) and Next.js prints whole error objects, so never
 * re-throw the original: keep only its name and first message line.
 */
export function sanitizeError(err: unknown, context: string): Error {
  if (err instanceof Error) {
    const firstLine = err.message.split('\n', 1)[0].slice(0, 200);
    return new Error(`${context}: ${err.name}: ${firstLine}`);
  }
  return new Error(`${context}: unknown error`);
}

/**
 * A one-line, credential-free description of a transport failure for logs and API responses.
 * Built only from the error's code and message, never from its request config or headers.
 */
export function describeTransportError(err: Error): string {
  const code = errorCode(err);
  if (isTlsError(err)) {
    return (
      `TLS certificate could not be verified (${code}). If antivirus or a proxy inspects HTTPS on ` +
      'this machine, start the server with NODE_OPTIONS=--use-system-ca so Node trusts the OS certificate store.'
    );
  }
  const message = err.message.split('\n', 1)[0].slice(0, 200);
  return code && !message.includes(code) ? `${message} (${code})` : message;
}

/** A PayPal REST failure, reduced to what the app and logs need. */
export interface PayPalFailure {
  status: number;
  /** PayPal's error name, e.g. UNPROCESSABLE_ENTITY. */
  name?: string;
  /** First detail issue, e.g. ORDER_NOT_APPROVED or INSTRUMENT_DECLINED. */
  issue?: string;
  description?: string;
  debugId?: string;
}

/**
 * True only when PayPal's answer proves the call did nothing, so a new PayPal-Request-Id is safe.
 * 408, 409 and PREVIOUS_REQUEST_IN_PROGRESS can mean the first request is still running: a fresh id
 * then would act twice, so those stay outcome-unknown and are replayed with the same id.
 *
 * On a `replay` of an outcome-unknown call, only a business answer (422) settles it. A 401, 403, 429 or
 * 400 refuses this replay, possibly before it reached the payment logic (a refused token fetch reads
 * the same way), and says nothing about what the first send did.
 */
export function isDefiniteRefusal(failure: PayPalFailure, replay = false): boolean {
  if (failure.status >= 500 || failure.status === 408 || failure.status === 409) return false;
  if (replay && failure.status !== 422) return false;
  return failure.issue !== 'PREVIOUS_REQUEST_IN_PROGRESS';
}

/**
 * Reads a PayPal error. Orders/Payments errors arrive as CustomError, whose payload keeps PayPal's
 * wire names (debug_id, details[].issue), not camelCase. Returns undefined for non-API errors.
 */
export function describePayPalError(err: unknown): PayPalFailure | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const payload = (err.result ?? parseBody(err.body)) as
    | {
        name?: unknown;
        message?: unknown;
        debug_id?: unknown;
        details?: Array<{ issue?: unknown; description?: unknown }>;
      }
    | undefined;
  const detail = Array.isArray(payload?.details) ? payload.details[0] : undefined;
  return {
    status: err.statusCode,
    name: asString(payload?.name),
    issue: asString(detail?.issue),
    description: asString(detail?.description) ?? asString(payload?.message),
    debugId: asString(payload?.debug_id) ?? err.headers?.['paypal-debug-id'],
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A bare ApiError leaves `result` undefined; its raw body may still be JSON. */
function parseBody(body: unknown): unknown {
  if (typeof body !== 'string' || body.length === 0) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    // Not JSON (e.g. an HTML page from a proxy): there is no structured payload to read. The
    // caller still has the status code.
    return undefined;
  }
}
