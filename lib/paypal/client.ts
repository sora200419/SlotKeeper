import 'server-only';
import {
  Client,
  Environment,
  OrdersController,
  type OAuthToken,
  PaymentsController,
  TransactionSearchController,
  VaultController,
  type Configuration,
} from '@paypal/paypal-server-sdk';
import { readPayPalSettings, type PayPalSettings } from './config';

/**
 * Client options for the PayPal Server SDK. Defaults checked against the SDK source
 * (src/defaultConfiguration.ts, v2.5.0): timeout 0 (no limit) and retries off, so both are set.
 */
export function buildClientConfiguration(settings: PayPalSettings): Partial<Configuration> {
  return {
    environment: settings.environment,
    timeout: settings.timeoutMs,
    clientCredentialsAuthCredentials: {
      oAuthClientId: settings.clientId,
      oAuthClientSecret: settings.clientSecret,
      // Refresh the cached token a minute early instead of racing its expiry.
      oAuthClockSkew: 60,
    },
    httpClientOptions: {
      timeout: settings.timeoutMs,
      retryConfig: {
        // Only idempotent methods. Money-moving POSTs are never re-sent by the SDK; callers retry
        // them explicitly with the same PayPal-Request-Id.
        httpMethodsToRetry: ['GET', 'PUT'],
        // Worst case for one GET: 2 attempts x timeout + ~1 s backoff, plus one more timeout if a token
        // must be fetched first (about 46 s at the 15 s default). The token request is never retried.
        maxNumberOfRetries: 1,
        // The generated default is 0, which disables retrying no matter what maxNumberOfRetries says.
        maximumRetryWaitTime: 10,
        retryInterval: 1,
        backoffFactor: 2,
        retryOnTimeout: true,
      },
    },
  };
}

export function createPayPalClient(settings: PayPalSettings): Client {
  return new Client(buildClientConfiguration(settings));
}

let sharedClient: Client | undefined;
let sharedToken: OAuthToken | undefined;

/**
 * An access token for PayPal REST endpoints the SDK doesn't cover (Payouts). Uses the SDK's own
 * token manager: the last token the SDK obtained is reused while valid (with the same clock skew),
 * otherwise a new one is fetched. `forceRefresh` after a 401 drops a token PayPal no longer accepts.
 */
export async function getAccessToken(forceRefresh = false): Promise<string> {
  const manager = getPayPalClient().clientCredentialsAuthManager;
  sharedToken = await manager.updateToken(forceRefresh ? undefined : sharedToken);
  return sharedToken.accessToken;
}

/** REST base URL matching the SDK environment. */
export function restBaseUrl(): string {
  return readPayPalSettings().environment === Environment.Production
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

/**
 * One long-lived client per server process, so the OAuth token is cached and reused. Only this
 * client shares its token with our REST calls (Payouts has no SDK support); clients built elsewhere,
 * possibly with other credentials, never touch the shared token.
 */
export function getPayPalClient(): Client {
  if (!sharedClient) {
    const config = buildClientConfiguration(readPayPalSettings());
    sharedClient = new Client({
      ...config,
      clientCredentialsAuthCredentials: {
        ...config.clientCredentialsAuthCredentials!,
        oAuthOnTokenUpdate: (token) => {
          sharedToken = token;
        },
      },
    });
  }
  return sharedClient;
}

/** Controllers are cheap wrappers over the shared client; build one per call site. */
export function getOrdersController(): OrdersController {
  return new OrdersController(getPayPalClient());
}

export function getPaymentsController(): PaymentsController {
  return new PaymentsController(getPayPalClient());
}

export function getTransactionSearchController(): TransactionSearchController {
  return new TransactionSearchController(getPayPalClient());
}

export function getVaultController(): VaultController {
  return new VaultController(getPayPalClient());
}
