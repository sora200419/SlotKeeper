import { NextResponse } from 'next/server';
import { getPayPalClient } from '@/lib/paypal/client';
import { PayPalConfigError, readPayPalSettings } from '@/lib/paypal/config';
import { checkPayPalCredentials, createCachedCredentialCheck } from '@/lib/paypal/health';

// The PayPal SDK needs Node APIs (Buffer); never let Next.js prerender a credential check.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** At most one OAuth token request per minute per server process, however often this is hit. */
const HEALTH_CACHE_TTL_MS = 60_000;

const cachedCheck = createCachedCredentialCheck(
  () => checkPayPalCredentials(getPayPalClient(), readPayPalSettings().environment),
  HEALTH_CACHE_TTL_MS,
);

export async function GET() {
  try {
    readPayPalSettings();
  } catch (err) {
    if (err instanceof PayPalConfigError) {
      return NextResponse.json(
        { ok: false, reason: 'missing_config', missing: err.missing, detail: err.message },
        { status: 500 },
      );
    }
    throw err;
  }

  const result = await cachedCheck();
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
