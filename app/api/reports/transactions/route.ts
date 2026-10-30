import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/responses';
import { requireStaff } from '@/lib/api/staff';
import { getBookingStore } from '@/lib/booking/store';
import { getTransactionSearchController } from '@/lib/paypal/client';
import { buildTransactionReport } from '@/lib/paypal/transaction-report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A year is up to 12 windows, each possibly several pages.
export const maxDuration = 120;

/**
 * Staff only. GET ?from=YYYY-MM-DD&to=YYYY-MM-DD (UTC days, inclusive): captured deposits, no-show
 * fees and refunds from PayPal Transaction Search, which can lag up to 3 hours.
 */
export async function GET(request: Request) {
  try {
    requireStaff(request);
    const url = new URL(request.url);
    const report = await buildTransactionReport(getTransactionSearchController(), getBookingStore(), {
      from: url.searchParams.get('from') ?? '',
      to: url.searchParams.get('to') ?? '',
    });
    return NextResponse.json(report);
  } catch (err) {
    return errorResponse(err);
  }
}
