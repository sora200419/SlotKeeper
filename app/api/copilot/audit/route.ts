import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/responses';
import { requireStaff } from '@/lib/api/staff';
import { getAuditLog } from '@/lib/copilot/plan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Staff only. Every action the copilot ran after approval, newest first, with its PayPal ids. */
export async function GET(request: Request) {
  try {
    requireStaff(request);
    return NextResponse.json({ entries: getAuditLog().list(200) });
  } catch (err) {
    return errorResponse(err);
  }
}
