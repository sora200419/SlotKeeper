import 'server-only';
import { PayPalConfigError } from '@/lib/paypal/config';

/**
 * Public base URL for PayPal return/cancel links. APP_URL (set in deployment) wins over the request's
 * Host header, which a proxy can rewrite or a client can spoof.
 */
export function appOrigin(request: Request, env: Record<string, string | undefined> = process.env): string {
  const configured = env.APP_URL?.trim();
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

/** Where PayPal sends the customer back after approving or cancelling a booking's deposit. */
export function depositReturnUrls(origin: string, bookingId: string) {
  return {
    returnUrl: `${origin}/book/${bookingId}?paypal=return`,
    cancelUrl: `${origin}/book/${bookingId}?paypal=cancel`,
  };
}
