import type { NextConfig } from 'next';

/**
 * Security headers on every response. Only headers that cannot break the PayPal JS SDK (its popup and
 * redirect need script, frame and opener access to paypal.com) or the Bryntum board: no script-src CSP,
 * no Cross-Origin-Opener-Policy, no form-action. Framing of our pages is refused (clickjacking).
 */
export const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  // Render serves the site over HTTPS only; browsers ignore this header on plain-HTTP localhost.
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
];

const nextConfig: NextConfig = {
  // Lets `next dev` accept requests on both localhost and 127.0.0.1.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  // Don't advertise the framework and version.
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
