import { Environment } from '@paypal/paypal-server-sdk';

/** Thrown when the PayPal environment variables are missing or invalid. */
export class PayPalConfigError extends Error {
  constructor(
    message: string,
    readonly missing: string[] = [],
  ) {
    super(message);
    this.name = 'PayPalConfigError';
  }
}

export interface PayPalSettings {
  environment: Environment;
  clientId: string;
  clientSecret: string;
  /** Per-request timeout in ms. The SDK default is 0, which means "wait forever". */
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

type Env = Record<string, string | undefined>;

/**
 * Reads PayPal settings from env vars. The client ID is NEXT_PUBLIC_ because the browser SDK
 * needs it; the secret never is.
 */
export function readPayPalSettings(env: Env = process.env): PayPalSettings {
  const clientId = env.NEXT_PUBLIC_PAYPAL_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();

  const missing: string[] = [];
  if (!clientId) missing.push('NEXT_PUBLIC_PAYPAL_CLIENT_ID');
  if (!clientSecret) missing.push('PAYPAL_CLIENT_SECRET');
  if (missing.length > 0) {
    throw new PayPalConfigError(
      `Missing PayPal settings: ${missing.join(', ')}. Copy .env.example to .env.local and fill them in.`,
      missing,
    );
  }

  const rawEnvironment = (env.NEXT_PUBLIC_PAYPAL_ENVIRONMENT ?? 'sandbox').trim().toLowerCase();
  let environment: Environment;
  if (rawEnvironment === 'sandbox') {
    environment = Environment.Sandbox;
  } else if (rawEnvironment === 'production') {
    // Live PayPal moves real money. This project is sandbox-only, so production needs a second,
    // deliberate opt-in and can't be reached by one mistyped variable.
    if (env.PAYPAL_ALLOW_PRODUCTION?.trim() !== 'true') {
      throw new PayPalConfigError(
        'NEXT_PUBLIC_PAYPAL_ENVIRONMENT=production is blocked: SlotKeeper runs on the PayPal sandbox. ' +
          'Set PAYPAL_ALLOW_PRODUCTION=true only if you really mean to use live money.',
      );
    }
    environment = Environment.Production;
  } else {
    throw new PayPalConfigError(
      `NEXT_PUBLIC_PAYPAL_ENVIRONMENT must be "sandbox" or "production", got "${rawEnvironment}".`,
    );
  }

  const rawTimeout = env.PAYPAL_TIMEOUT_MS?.trim();
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (rawTimeout) {
    timeoutMs = Number(rawTimeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new PayPalConfigError(
        `PAYPAL_TIMEOUT_MS must be a positive integer (milliseconds), got "${rawTimeout}".`,
      );
    }
  }

  return { environment, clientId: clientId!, clientSecret: clientSecret!, timeoutMs };
}
