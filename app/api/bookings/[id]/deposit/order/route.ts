import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/responses';
import { getBookingStore } from '@/lib/booking/store';
import { getOrdersController } from '@/lib/paypal/client';
import { PayPalConfigError } from '@/lib/paypal/config';
import { createDepositOrder } from '@/lib/paypal/deposits';

export const runtime = 'nodejs';

/**
 * Public base URL for PayPal return/cancel links. APP_URL (set in deployment) wins over the request's
 * Host header, which a proxy can rewrite or a client can spoof.
 */
function appOrigin(request: Request): string {
  const configured = process.env.APP_URL?.trim();
  if (configured) {
    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      throw new PayPalConfigError(`APP_URL must be an absolute http(s) URL, got "${configured}".`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new PayPalConfigError('APP_URL must use http or https.');
    }
    return url.origin;
  }
  return new URL(request.url).origin;
}

/** Called by the JS SDK v6 session's order promise. Returns { orderId }. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const origin = appOrigin(request);
    const result = await createDepositOrder(getOrdersController(), getBookingStore(), id, {
      returnUrl: `${origin}/book/${id}?paypal=return`,
      cancelUrl: `${origin}/book/${id}?paypal=cancel`,
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
