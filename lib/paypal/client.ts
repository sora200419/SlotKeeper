import 'server-only';
import {
  Client,
  OrdersController,
  PaymentsController,
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
        // Worst case for one GET: 2 attempts x timeout + ~1 s backoff (about 31 s at the 15 s default).
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

/** One long-lived client per server process, so the OAuth token is cached and reused. */
export function getPayPalClient(): Client {
  sharedClient ??= createPayPalClient(readPayPalSettings());
  return sharedClient;
}

/** Controllers are cheap wrappers over the shared client; build one per call site. */
export function getOrdersController(): OrdersController {
  return new OrdersController(getPayPalClient());
}

export function getPaymentsController(): PaymentsController {
  return new PaymentsController(getPayPalClient());
}
