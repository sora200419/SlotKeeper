import { NextResponse } from 'next/server';
import { getBookingStore } from '@/lib/booking/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const booking = getBookingStore().get(id);
  if (!booking) {
    return NextResponse.json({ error: 'booking_not_found', message: 'Booking not found.' }, { status: 404 });
  }
  return NextResponse.json(booking);
}
