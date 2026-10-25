import 'server-only';
import { NextResponse } from 'next/server';
import { BookingInputError } from '@/lib/booking/bookings';
import { PayPalConfigError } from '@/lib/paypal/config';
import { DepositError } from '@/lib/paypal/deposits';
import { sanitizeError } from '@/lib/paypal/errors';

/**
 * Maps known errors to JSON responses. PayPal debug ids are passed through (they help support);
 * secrets never are. Unknown errors are re-thrown so Next.js logs them as real 500s.
 */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof DepositError) {
    return NextResponse.json(
      {
        error: err.code,
        message: err.message,
        paypalIssue: err.paypal?.issue,
        paypalDebugId: err.paypal?.debugId,
      },
      { status: err.httpStatus },
    );
  }
  if (err instanceof BookingInputError) {
    return NextResponse.json({ error: 'invalid_input', message: err.message }, { status: 400 });
  }
  if (err instanceof PayPalConfigError) {
    return NextResponse.json(
      { error: 'missing_config', message: err.message, missing: err.missing },
      { status: 500 },
    );
  }
  // Never re-throw the raw error: it can carry the request's Authorization header.
  throw sanitizeError(err, 'Unexpected error');
}

/** Parses a JSON object body; anything else is a 400, not a crash. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new BookingInputError('Request body must be JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BookingInputError('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}
