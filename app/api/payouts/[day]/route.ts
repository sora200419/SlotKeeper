import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/responses';
import { requireStaff } from '@/lib/api/staff';
import { getPayoutDeps } from '@/lib/paypal/payout-deps';
import { refreshPayouts } from '@/lib/paypal/payouts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Staff only. The day's payout batch, with item statuses read back from PayPal. */
export async function GET(request: Request, { params }: { params: Promise<{ day: string }> }) {
  const { day } = await params;
  try {
    requireStaff(request);
    return NextResponse.json(await refreshPayouts(getPayoutDeps(), day));
  } catch (err) {
    return errorResponse(err);
  }
}
