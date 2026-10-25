import { NextResponse } from 'next/server';
import { errorResponse, readJsonObject } from '@/lib/api/responses';
import { BookingInputError } from '@/lib/booking/bookings';
import { getBookingStore } from '@/lib/booking/store';
import { getOrdersController } from '@/lib/paypal/client';
import { authorizeDeposit } from '@/lib/paypal/deposits';

export const runtime = 'nodejs';

/** Called from the JS SDK v6 onApprove callback with { orderId }. Holds the deposit. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await readJsonObject(request);
    if (typeof body.orderId !== 'string' || body.orderId.length === 0) {
      throw new BookingInputError('orderId is required.');
    }
    const booking = await authorizeDeposit(getOrdersController(), getBookingStore(), id, body.orderId);
    return NextResponse.json(booking);
  } catch (err) {
    return errorResponse(err);
  }
}
