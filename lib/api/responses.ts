import 'server-only';
import { NextResponse } from 'next/server';
import { BookingInputError } from '@/lib/booking/bookings';
import { BookingBusyError } from '@/lib/booking/locks';
import type { Booking } from '@/lib/booking/store';
import { PayPalConfigError } from '@/lib/paypal/config';
import { DepositError } from '@/lib/paypal/deposits';
import { sanitizeError } from '@/lib/paypal/errors';
import { PayoutError } from '@/lib/paypal/payouts';
import { CopilotError } from '@/lib/copilot/copilot';
import { PlanError } from '@/lib/copilot/execute';
import { StaffAuthError } from './staff';

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
  if (err instanceof CopilotError || err instanceof PlanError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.httpStatus });
  }
  if (err instanceof PayoutError) {
    return NextResponse.json(
      { error: err.code, message: err.message, paypalIssue: err.paypal?.issue ?? err.paypal?.name, paypalDebugId: err.paypal?.debugId },
      { status: err.httpStatus },
    );
  }
  if (err instanceof BookingBusyError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.httpStatus });
  }
  if (err instanceof StaffAuthError) {
    return NextResponse.json(
      { error: err.httpStatus === 401 ? 'unauthorized' : 'staff_disabled', message: err.message },
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

/**
 * A booking as customer-facing routes may show it: the saved wallet's vault and PayPal customer ids
 * are staff-only (whoever has them plus our credentials can charge the wallet), so only its status
 * is kept. Staff routes and the staff SSE feed return the full booking.
 */
export function publicBooking(booking: Booking): Booking {
  // The booking token's hash is a credential check value; it never leaves the server.
  const { accessTokenHash: _hash, ...rest } = booking;
  const wallet = rest.hold?.savedWallet;
  if (!wallet) return rest;
  return {
    ...rest,
    hold: { ...rest.hold!, savedWallet: { status: wallet.status, savedAt: wallet.savedAt } },
  };
}

/** Like readJsonObject, but an empty body (whatever its Content-Type) means `{}`. */
export async function readOptionalJsonObject(request: Request): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new BookingInputError('Request body could not be read.');
  }
  if (text.trim() === '') return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BookingInputError('Request body must be JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BookingInputError('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
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
