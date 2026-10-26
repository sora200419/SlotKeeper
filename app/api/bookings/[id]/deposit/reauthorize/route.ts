import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/responses';
import { requireStaff } from '@/lib/api/staff';
import { getBookingStore } from '@/lib/booking/store';
import { getPaymentsController } from '@/lib/paypal/client';
import { reauthorizeDeposit } from '@/lib/paypal/deposit-actions';

export const runtime = 'nodejs';

/** Staff only. Renews the hold after PayPal's 3-day honor period (once, days 4–29). No body. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    requireStaff(request);
    const booking = await reauthorizeDeposit(getPaymentsController(), getBookingStore(), id);
    return NextResponse.json(booking);
  } catch (err) {
    return errorResponse(err);
  }
}
