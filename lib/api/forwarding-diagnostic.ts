import { createHash, randomBytes } from 'node:crypto';

/**
 * TEMPORARY diagnostic (test plan 6.7): the live hold_slot rate limit never triggered, so we need to see
 * which proxy headers reach the app on Render and whether the X-Forwarded-For entries change between
 * requests from one client. No address is logged in full: each one is cut to its first half plus a short
 * hash salted per process, so equal addresses show equal tags without revealing them. Remove once the
 * rate-limit key is fixed.
 */
const PROCESS_SALT = randomBytes(16);
const MAX_XFF_ENTRIES = 5;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
// Hex groups and '::' only, optionally ending in an IPv4 tail (::ffff:a.b.c.d). Anything else, such as
// ip:port, [v6]:port, for=… or a comma list, is not an address and gets only a shape hint.
const IPV6 = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){1,7}$/i;
const IPV6_V4_TAIL = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){1,6}:\d{1,3}(\.\d{1,3}){3}$/i;

function shape(value: string): string {
  if (value.includes(',')) return 'list';
  if (/^\[.*\]:\d+$/.test(value)) return 'v6port';
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value)) return 'v4port';
  return 'other';
}

export function maskAddress(value: string, salt: Uint8Array = PROCESS_SALT): string {
  const ip = value.trim();
  const tag = createHash('sha256').update(salt).update(ip).digest('hex').slice(0, 8);
  if (IPV4.test(ip)) return `${ip.split('.').slice(0, 2).join('.')}.*.*#${tag}`;
  if (IPV6.test(ip) || IPV6_V4_TAIL.test(ip)) return `${ip.split(':').slice(0, 2).join(':')}:*#${tag}`;
  return `?${shape(ip)}#${tag}`;
}

function maskedHeader(request: Request, name: string, salt: Uint8Array): string | null {
  const value = request.headers.get(name);
  return value ? maskAddress(value, salt) : null;
}

export function describeForwarding(request: Request, salt: Uint8Array = PROCESS_SALT) {
  const xff = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    // Tags are only comparable within one process (the salt is per process).
    pid: process.pid,
    xffCount: xff.length,
    // The header comes from the client and has no entry cap: keep the last few, where proxies append.
    xff: xff.slice(-MAX_XFF_ENTRIES).map((entry) => maskAddress(entry, salt)),
    xRealIp: maskedHeader(request, 'x-real-ip', salt),
    cfConnectingIp: maskedHeader(request, 'cf-connecting-ip', salt),
    trueClientIp: maskedHeader(request, 'true-client-ip', salt),
    envoyExternal: maskedHeader(request, 'x-envoy-external-address', salt),
    forwarded: request.headers.has('forwarded'),
  };
}
