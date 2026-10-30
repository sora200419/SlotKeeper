import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/responses';
import { requireStaff } from '@/lib/api/staff';
import { PlanError } from '@/lib/copilot/execute';
import { getPlanStore } from '@/lib/copilot/plan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Staff only. A plan with its steps and, once run, each step's result. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    requireStaff(request);
    const plan = getPlanStore().get(id);
    if (!plan) throw new PlanError('not_found', 404, 'Plan not found.');
    return NextResponse.json(plan);
  } catch (err) {
    return errorResponse(err);
  }
}
