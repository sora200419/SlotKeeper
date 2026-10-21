import { ApiError, type Environment } from '@paypal/paypal-server-sdk';

/** The slice of the SDK client the health check needs; lets tests pass a stub. */
export interface TokenSource {
  clientCredentialsAuthManager: {
    fetchToken(): Promise<{ expiresIn?: bigint }>;
  };
}

export type CredentialCheck =
  | { ok: true; environment: Environment; tokenExpiresInSeconds: number | null }
  | {
      ok: false;
      environment: Environment;
      reason: 'invalid_credentials' | 'paypal_error' | 'network_error';
      status?: number;
      debugId?: string;
      detail: string;
    };

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

function isNetworkError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) || err.name === 'AbortError';
}

/**
 * Proves the configured credentials work by requesting an OAuth token. Nothing is created and no
 * money moves. The token itself is never returned. Unexpected (non-PayPal, non-network) errors are
 * re-thrown so programming bugs aren't disguised as outages.
 */
export async function checkPayPalCredentials(
  client: TokenSource,
  environment: Environment,
): Promise<CredentialCheck> {
  try {
    const token = await client.clientCredentialsAuthManager.fetchToken();
    return {
      ok: true,
      environment,
      tokenExpiresInSeconds: token.expiresIn === undefined ? null : Number(token.expiresIn),
    };
  } catch (err) {
    // OAuthProviderError can't be used with instanceof: the package root exports a same-named enum
    // that shadows the error class. Branch on ApiError, the status code and the payload instead.
    if (err instanceof ApiError) {
      const debugId = err.headers?.['paypal-debug-id'];
      const provider = readProviderError(err);
      const providerText = provider.code
        ? [provider.code, provider.description].filter(Boolean).join(': ')
        : undefined;
      console.error('[paypal] token request failed', {
        status: err.statusCode,
        debugId,
        error: provider.code,
      });
      // Only these mean the ID/secret were rejected; other 400s (bad grant type, malformed request)
      // are integration problems, not credential problems.
      if (err.statusCode === 401 || provider.code === 'invalid_client') {
        return {
          ok: false,
          environment,
          reason: 'invalid_credentials',
          status: err.statusCode,
          debugId,
          detail:
            `PayPal rejected the client ID/secret (${providerText ?? `HTTP ${err.statusCode}`}). ` +
            'Check that both come from the same app and match NEXT_PUBLIC_PAYPAL_ENVIRONMENT.',
        };
      }
      return {
        ok: false,
        environment,
        reason: 'paypal_error',
        status: err.statusCode,
        debugId,
        detail: `PayPal returned HTTP ${err.statusCode}${providerText ? ` (${providerText})` : ''}.`,
      };
    }
    if (isNetworkError(err)) {
      console.error('[paypal] token request could not reach PayPal', { message: err.message });
      return {
        ok: false,
        environment,
        reason: 'network_error',
        detail: `Could not reach PayPal: ${err.message}`,
      };
    }
    throw err;
  }
}

/** Error payload fields keep PayPal's wire names (error, error_description), not camelCase. */
function readProviderError(err: ApiError): { code?: string; description?: string } {
  const result = err.result as { error?: unknown; error_description?: unknown } | undefined;
  return {
    code: typeof result?.error === 'string' && result.error ? result.error : undefined,
    description:
      typeof result?.error_description === 'string' && result.error_description
        ? result.error_description
        : undefined,
  };
}

/**
 * Wraps the check so repeated calls within `ttlMs` reuse one result (and one in-flight request).
 * `fetchToken` bypasses the SDK's token cache, so an uncached public endpoint would let anyone hammer
 * PayPal's OAuth endpoint with this app's credentials.
 */
export function createCachedCredentialCheck(
  check: () => Promise<CredentialCheck>,
  ttlMs: number,
  now: () => number = Date.now,
): () => Promise<CredentialCheck> {
  let cached: { at: number; result: Promise<CredentialCheck> } | undefined;
  return () => {
    if (cached && now() - cached.at < ttlMs) return cached.result;
    const result = check();
    cached = { at: now(), result };
    // A thrown (unexpected) error is not cached, so the next call tries again.
    result.catch(() => {
      if (cached?.result === result) cached = undefined;
    });
    return result;
  };
}
