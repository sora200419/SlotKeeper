import { Environment } from '@paypal/paypal-server-sdk';
import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/responses';
import { readPayPalSettings } from '@/lib/paypal/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SDK_URLS: Record<Environment, string> = {
  [Environment.Sandbox]: 'https://www.sandbox.paypal.com/web-sdk/v6/core',
  [Environment.Production]: 'https://www.paypal.com/web-sdk/v6/core',
};

/** Public browser config for the JS SDK v6. The client ID is public by design; the secret never leaves the server. */
export async function GET() {
  try {
    const settings = readPayPalSettings();
    return NextResponse.json({ clientId: settings.clientId, sdkUrl: SDK_URLS[settings.environment] });
  } catch (err) {
    return errorResponse(err);
  }
}
