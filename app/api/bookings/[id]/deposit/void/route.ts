import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/responses';
import { requireStaff } from '@/lib/api/staff';
import { getBookingStore } from '@/lib/booking/store';
import { getPaymentsController } from '@/lib/paypal/client';
import { voidDeposit } from '@/lib/paypal/deposit-actions';

export const runtime = 'nodejs';

/** Staff only. Releases the deposit hold (cancellation within policy). No body. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    requireStaff(request);
    const booking = await voidDeposit(getPaymentsController(), getBookingStore(), id);
    return NextResponse.json(booking);
  } catch (err) {
    return errorResponse(err);
  }
}
