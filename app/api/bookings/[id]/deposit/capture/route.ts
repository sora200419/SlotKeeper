import { NextResponse } from 'next/server';
import { errorResponse, readJsonObject } from '@/lib/api/responses';
import { requireStaff } from '@/lib/api/staff';
import { BookingInputError } from '@/lib/booking/bookings';
import { getBookingStore } from '@/lib/booking/store';
import { getPaymentsController } from '@/lib/paypal/client';
import { captureDeposit } from '@/lib/paypal/deposit-actions';

export const runtime = 'nodejs';

/**
 * Staff only. Body: { reason: "completed" } captures the whole deposit;
 * { reason: "no_show", amountCents?: number } captures a no-show fee and releases the rest.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    requireStaff(request);
    const body = await readJsonObject(request);
    if (body.reason !== 'completed' && body.reason !== 'no_show') {
      throw new BookingInputError('reason must be "completed" or "no_show".');
    }
    if (body.amountCents !== undefined && typeof body.amountCents !== 'number') {
      throw new BookingInputError('amountCents must be a number of cents.');
    }
    const booking = await captureDeposit(getPaymentsController(), getBookingStore(), id, {
      reason: body.reason,
      amountCents: body.amountCents,
    });
    return NextResponse.json(booking);
  } catch (err) {
    return errorResponse(err);
  }
}
