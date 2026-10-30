import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/responses';
import { requireStaff } from '@/lib/api/staff';
import { getBookingStore } from '@/lib/booking/store';
import { approvePlan } from '@/lib/copilot/execute';
import { getAuditLog, getPlanStore } from '@/lib/copilot/plan';
import { getOrdersController, getPaymentsController, getVaultController } from '@/lib/paypal/client';
import { getPayoutDeps } from '@/lib/paypal/payout-deps';

export const runtime = 'nodejs';
export const maxDuration = 120;

/** Staff only. The owner approves a proposed plan: its steps run now, in order, and are audited. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    requireStaff(request);
    const plan = await approvePlan(
      {
        bookings: getBookingStore(),
        plans: getPlanStore(),
        audit: getAuditLog(),
        payments: getPaymentsController(),
        wallet: { orders: getOrdersController(), vault: getVaultController() },
        payouts: getPayoutDeps,
      },
      id,
    );
    return NextResponse.json(plan);
  } catch (err) {
    return errorResponse(err);
  }
}
