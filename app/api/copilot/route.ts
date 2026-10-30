import { NextResponse } from 'next/server';
import { errorResponse, readJsonObject } from '@/lib/api/responses';
import { requireStaff } from '@/lib/api/staff';
import { BookingInputError } from '@/lib/booking/bookings';
import { getBookingStore } from '@/lib/booking/store';
import { createCopilotModel, runCopilot } from '@/lib/copilot/copilot';
import { getPlanStore } from '@/lib/copilot/plan';
import { readBusinessTimeZone } from '@/lib/paypal/payout-deps';

export const runtime = 'nodejs';
// The model may take a while to plan (adaptive thinking, several tool calls).
export const maxDuration = 120;

/**
 * Staff only. Body: { message }. The owner's request goes to the copilot, which reads bookings and
 * answers or proposes a plan. A plan is only proposed here; POST /api/copilot/plans/<id>/approve runs it.
 */
export async function POST(request: Request) {
  try {
    requireStaff(request);
    const body = await readJsonObject(request);
    if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 2000) {
      throw new BookingInputError('message must be 1-2000 characters.');
    }
    const result = await runCopilot(
      { model: createCopilotModel(), bookings: getBookingStore(), plans: getPlanStore(), timeZone: readBusinessTimeZone() },
      body.message.trim(),
    );
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
