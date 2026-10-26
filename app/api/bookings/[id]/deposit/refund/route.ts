import { NextResponse } from 'next/server';
import { errorResponse, readJsonObject } from '@/lib/api/responses';
import { requireStaff } from '@/lib/api/staff';
import { BookingInputError } from '@/lib/booking/bookings';
import { getBookingStore } from '@/lib/booking/store';
import { getPaymentsController } from '@/lib/paypal/client';
import { refundDeposit } from '@/lib/paypal/deposit-actions';

export const runtime = 'nodejs';

/** Staff only. Body: { amountCents?: number }; without an amount, refunds everything still refundable. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    requireStaff(request);
    const body = await readJsonObject(request);
    if (body.amountCents !== undefined && typeof body.amountCents !== 'number') {
      throw new BookingInputError('amountCents must be a number of cents.');
    }
    const booking = await refundDeposit(getPaymentsController(), getBookingStore(), id, {
      amountCents: body.amountCents,
    });
    return NextResponse.json(booking);
  } catch (err) {
    return errorResponse(err);
  }
}
