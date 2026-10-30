import { NextResponse } from 'next/server';
import { errorResponse, staffBooking } from '@/lib/api/responses';
import { requireStaff } from '@/lib/api/staff';
import { listServices } from '@/lib/booking/catalog';
import { listStaff } from '@/lib/booking/staff';
import { getBookingStore } from '@/lib/booking/store';
import { readBusinessTimeZone } from '@/lib/paypal/payout-deps';
import { queuedWrites } from '@/lib/storage/records';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Staff only. Everything the staff board draws; /api/bookings/events then keeps it current. */
export async function GET(request: Request) {
  try {
    requireStaff(request);
    return NextResponse.json({
      staff: listStaff().map(({ id, name }) => ({ id, name })),
      services: listServices().map(({ id, name, durationMinutes }) => ({ id, name, durationMinutes })),
      timeZone: readBusinessTimeZone(),
      bookings: getBookingStore().list().map(staffBooking),
      unsavedWrites: queuedWrites(),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
