import { NextResponse } from 'next/server';
import { appOrigin, depositReturnUrls } from '@/lib/api/app-origin';
import { errorResponse, readOptionalJsonObject } from '@/lib/api/responses';
import { BookingInputError } from '@/lib/booking/bookings';
import { getBookingStore } from '@/lib/booking/store';
import { getOrdersController } from '@/lib/paypal/client';
import { createDepositOrder } from '@/lib/paypal/deposits';

export const runtime = 'nodejs';

/**
 * Called by the JS SDK v6 session's order promise. Optional JSON body { savePayment: true } when the
 * customer agreed to save their PayPal wallet. Returns { orderId }.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const origin = appOrigin(request);
    // Empty body (older clients send none): no wallet saving.
    const body = await readOptionalJsonObject(request);
    if (body.savePayment !== undefined && typeof body.savePayment !== 'boolean') {
      throw new BookingInputError('savePayment must be true or false.');
    }
    const result = await createDepositOrder(
      getOrdersController(),
      getBookingStore(),
      id,
      depositReturnUrls(origin, id),
      new Date(),
      { savePayment: body.savePayment === true },
    );
    return NextResponse.json({ orderId: result.orderId });
  } catch (err) {
    return errorResponse(err);
  }
}
