import { NextResponse } from 'next/server';
import { errorResponse, readJsonObject } from '@/lib/api/responses';
import { createBooking } from '@/lib/booking/bookings';
import { getBookingStore } from '@/lib/booking/store';

export const runtime = 'nodejs';

/** Creates a booking awaiting its deposit. The price comes from the catalog, never the request. */
export async function POST(request: Request) {
  try {
    const body = await readJsonObject(request);
    const booking = createBooking(getBookingStore(), {
      serviceId: body.serviceId,
      customerName: body.customerName,
      startsAt: body.startsAt,
    });
    return NextResponse.json(booking, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
