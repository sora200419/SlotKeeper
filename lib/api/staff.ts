import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';

export class StaffAuthError extends Error {
  constructor(
    readonly httpStatus: 401 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'StaffAuthError';
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Money actions (capture, void, reauthorize, refund) are staff-only. Until real staff login exists,
 * callers send STAFF_API_TOKEN as `Authorization: Bearer <token>` or `x-staff-token`.
 * With no token configured the routes stay closed (503) rather than open.
 */
export function requireStaff(request: Request, env: NodeJS.ProcessEnv = process.env): void {
  const expected = env.STAFF_API_TOKEN?.trim();
  if (!expected) {
    throw new StaffAuthError(503, 'Staff actions are disabled: STAFF_API_TOKEN is not set on the server.');
  }
  const header = request.headers.get('authorization');
  const presented = header?.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : request.headers.get('x-staff-token')?.trim();
  // Compare fixed-length digests so neither length nor content leaks through timing.
  if (!presented || !timingSafeEqual(digest(presented), digest(expected))) {
    throw new StaffAuthError(401, 'A valid staff token is required.');
  }
}
