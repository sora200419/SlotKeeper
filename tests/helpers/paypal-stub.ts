import {
  Client,
  Environment,
  OrdersController,
  PaymentsController,
  TransactionSearchController,
  VaultController,
} from '@paypal/paypal-server-sdk';

export type Reply = { status: number; body?: unknown } | { throw: Error };
export type CapturedRequest = { method: string; url: string; headers: Record<string, string>; body: any };

/**
 * A real Server SDK client over a stub axios adapter (the SDK's `unstable_httpClientOptions` seam),
 * with a seeded OAuth token so no token request goes through the adapter. Replies are consumed in
 * order; an unexpected extra request fails the test.
 */
export function stubPayPal(...replies: Reply[]) {
  const requests: CapturedRequest[] = [];
  const queue = [...replies];
  const client = new Client({
    environment: Environment.Sandbox,
    clientCredentialsAuthCredentials: {
      oAuthClientId: 'dummy-id',
      oAuthClientSecret: 'dummy-secret',
      oAuthToken: {
        accessToken: 'seeded-token',
        tokenType: 'Bearer',
        expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      },
    },
    httpClientOptions: { retryConfig: { maxNumberOfRetries: 0 } },
    unstable_httpClientOptions: {
      adapter: async (config: any) => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(config.headers ?? {})) {
          headers[key.toLowerCase()] = String(value);
        }
        requests.push({
          method: String(config.method).toUpperCase(),
          url: config.url,
          headers,
          body: config.data ? JSON.parse(config.data) : undefined,
        });
        const reply = queue.shift();
        if (!reply) throw new Error('Unexpected PayPal request in test');
        if ('throw' in reply) throw reply.throw;
        return {
          data: reply.body === undefined ? '' : JSON.stringify(reply.body),
          status: reply.status,
          statusText: '',
          headers: reply.body === undefined ? {} : { 'content-type': 'application/json' },
          config,
        };
      },
    },
  });
  return {
    orders: new OrdersController(client),
    payments: new PaymentsController(client),
    vault: new VaultController(client),
    transactionSearch: new TransactionSearchController(client),
    requests,
    remaining: () => queue.length,
  };
}

export const networkDrop = (): Reply => ({
  throw: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
});
