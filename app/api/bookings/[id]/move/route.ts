import { NextResponse } from 'next/server';
import { errorResponse, readJsonObject, staffBooking } from '@/lib/api/responses';
import { requireStaff } from '@/lib/api/staff';
import { moveSlotProblem } from '@/lib/booking/availability';
import { BookingInputError, moveBooking } from '@/lib/booking/bookings';
import { getBookingStore } from '@/lib/booking/store';
import { readBusinessTimeZone } from '@/lib/paypal/payout-deps';

export const runtime = 'nodejs';

/**
 * Staff only. Moves a booking to another time and/or staff member (drag on the board). No money moves:
 * a held deposit stays held. Body: { startsAt?: ISO instant, staffId?: string }. The new place must be a
 * free slot for that staff member, inside the deposit's honor period.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    requireStaff(request);
    const body = await readJsonObject(request);
    if (body.startsAt !== undefined && typeof body.startsAt !== 'string') throw new BookingInputError('startsAt must be a string.');
    if (body.staffId !== undefined && typeof body.staffId !== 'string') throw new BookingInputError('staffId must be a string.');
    const timeZone = readBusinessTimeZone();
    const store = getBookingStore();
    const now = new Date();
    const moved = await moveBooking(
      store,
      id,
      { startsAt: body.startsAt as string | undefined, staffId: body.staffId as string | undefined },
      now,
      (booking, target) => (target.staffId ? moveSlotProblem(store, booking, target.staffId, target.startsAt, timeZone, now) : 'Pick a staff member.'),
    );
    return NextResponse.json(staffBooking(moved));
  } catch (err) {
    return errorResponse(err);
  }
}
