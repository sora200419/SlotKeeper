const MAX_KEY_LENGTH = 64;

/**
 * Who is calling, for rate limiting. On Render every request passes through Cloudflare, which sets
 * CF-Connecting-IP to the address that connected and answers 403 to a request that brings its own
 * (checked on the live site, 11-09), so that header is trusted only because Render fronts the service
 * with Cloudflare. Anywhere else (local runs, or a host reachable without Cloudflare) a client can send
 * a new value on every request and the limits are bypassable; that is accepted for this sandbox demo.
 * The last X-Forwarded-For entry cannot be used: it is a Cloudflare hop that changes between requests,
 * so keying on it never saw one client twice (live diagnostic, 11-09). Without the header it falls back
 * to that last entry, then to 'unknown'.
 */
export function clientKey(request: Request): string {
  const cloudflare = request.headers.get('cf-connecting-ip')?.trim();
  if (cloudflare) return cloudflare.slice(0, MAX_KEY_LENGTH);
  const lastForwarded = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim();
  return (lastForwarded || 'unknown').slice(0, MAX_KEY_LENGTH);
}
