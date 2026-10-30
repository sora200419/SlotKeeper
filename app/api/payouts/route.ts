import { NextResponse } from 'next/server';
import { errorResponse, readOptionalJsonObject } from '@/lib/api/responses';
import { requireStaff } from '@/lib/api/staff';
import { BookingInputError } from '@/lib/booking/bookings';
import { getPayoutDeps, yesterdayInBusinessZone } from '@/lib/paypal/payout-deps';
import { runDailyPayouts } from '@/lib/paypal/payouts';

export const runtime = 'nodejs';

/**
 * Staff only (and the daily cron job, run after midnight). Pays every staff member's commission and
 * tips for one finished business day. Body: { day?: "YYYY-MM-DD" }, default yesterday in
 * BUSINESS_TIME_ZONE; today or later is refused. Safe to call again: an already-sent day only
 * refreshes its status, an unconfirmed one is replayed.
 */
export async function POST(request: Request) {
  try {
    requireStaff(request);
    const body = await readOptionalJsonObject(request);
    if (body.day !== undefined && typeof body.day !== 'string') {
      throw new BookingInputError('day must be a date string like 2026-11-01.');
    }
    const record = await runDailyPayouts(getPayoutDeps(), body.day ?? yesterdayInBusinessZone());
    return NextResponse.json(record);
  } catch (err) {
    return errorResponse(err);
  }
}
