import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/responses';
import { requireStaff } from '@/lib/api/staff';
import { rejectPlan } from '@/lib/copilot/execute';
import { getPlanStore } from '@/lib/copilot/plan';

export const runtime = 'nodejs';

/** Staff only. The owner turns a proposed plan down; nothing runs. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    requireStaff(request);
    return NextResponse.json(await rejectPlan(getPlanStore(), id));
  } catch (err) {
    return errorResponse(err);
  }
}
