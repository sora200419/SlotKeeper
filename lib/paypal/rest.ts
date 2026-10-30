import 'server-only';
import { describeTransportError, isNetworkError, type PayPalFailure } from './errors';

/** PayPal answered with an error status. Its outcome is known (for 4xx: nothing happened). */
export class PayPalRestError extends Error {
  constructor(readonly failure: PayPalFailure) {
    super(`PayPal answered HTTP ${failure.status}${failure.issue ? ` (${failure.issue})` : failure.name ? ` (${failure.name})` : ''}.`);
    this.name = 'PayPalRestError';
  }
}

/** No usable answer (network, timeout, unreadable body): whatever was sent may or may not have happened. */
export class PayPalUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayPalUnreachableError';
  }
}

export interface RestRequest {
  method: 'GET' | 'POST';
  /** Path with query string, e.g. /v1/payments/payouts. */
  path: string;
  body?: unknown;
  /** PayPal-Request-Id: the same id replays PayPal's stored result instead of acting twice. */
  requestId?: string;
}

export interface RestTransport {
  request<T>(request: RestRequest): Promise<T>;
}

/**
 * Calls PayPal REST endpoints the Server SDK doesn't cover (Payouts). The token comes from the shared
 * SDK client's token manager; after a 401 it is refreshed once and the call repeated (safe: GETs
 * are reads, POSTs carry a PayPal-Request-Id). Errors never include the request or its headers.
 */
export function createRestTransport(options: {
  baseUrl: string;
  getToken: (forceRefresh: boolean) => Promise<string>;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}): RestTransport {
  const { baseUrl, getToken, timeoutMs, fetchFn = fetch } = options;

  async function send(request: RestRequest, token: string): Promise<Response> {
    try {
      return await fetchFn(`${baseUrl}${request.path}`, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(request.requestId ? { 'PayPal-Request-Id': request.requestId } : {}),
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      const reason = isNetworkError(err) ? describeTransportError(err) : err instanceof Error ? err.name : 'unknown error';
      throw new PayPalUnreachableError(`Could not reach PayPal for ${request.method} ${request.path.split('?')[0]}: ${reason}`);
    }
  }

  // The SDK's token errors can carry the token request, including `Authorization: Basic <id:secret>`
  // (F-002). Only the error's name and first line leave this function.
  async function token(forceRefresh: boolean): Promise<string> {
    try {
      return await getToken(forceRefresh);
    } catch (err) {
      const summary = err instanceof Error ? `${err.name}: ${err.message.split('\n', 1)[0].slice(0, 200)}` : 'unknown error';
      throw new PayPalUnreachableError(`Could not get a PayPal access token (${summary}).`);
    }
  }

  return {
    async request<T>(request: RestRequest): Promise<T> {
      let response = await send(request, await token(false));
      if (response.status === 401) response = await send(request, await token(true));

      let text: string;
      try {
        text = await response.text();
      } catch (err) {
        throw new PayPalUnreachableError(
          `PayPal's answer to ${request.method} ${request.path.split('?')[0]} could not be read (${err instanceof Error ? err.name : 'unknown'}).`,
        );
      }
      let body: unknown;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          // A non-JSON body (proxy error page): readable status, nothing structured to report.
          body = undefined;
        }
      }
      if (!response.ok) {
        const payload = body as
          | { name?: unknown; message?: unknown; debug_id?: unknown; details?: Array<{ issue?: unknown }> }
          | undefined;
        const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
        throw new PayPalRestError({
          status: response.status,
          name: str(payload?.name),
          issue: str(Array.isArray(payload?.details) ? payload.details[0]?.issue : undefined),
          description: str(payload?.message),
          debugId: str(payload?.debug_id) ?? response.headers.get('paypal-debug-id') ?? undefined,
        });
      }
      if (body === undefined) {
        throw new PayPalUnreachableError(`PayPal's answer to ${request.method} ${request.path.split('?')[0]} was not JSON.`);
      }
      return body as T;
    },
  };
}
