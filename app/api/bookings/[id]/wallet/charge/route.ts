import { NextResponse } from 'next/server';
import { errorResponse, readJsonObject } from '@/lib/api/responses';
import { requireStaff } from '@/lib/api/staff';
import { BookingInputError } from '@/lib/booking/bookings';
import { getBookingStore } from '@/lib/booking/store';
import { getOrdersController, getVaultController } from '@/lib/paypal/client';
import { chargeSavedWallet } from '@/lib/paypal/deposit-actions';

export const runtime = 'nodejs';

/**
 * Staff only. Charges the customer's saved PayPal wallet without them present.
 * Body: { amountCents?: number } (defaults to what is left of the deposit after its capture).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    requireStaff(request);
    const body = await readJsonObject(request);
    if (body.amountCents !== undefined && typeof body.amountCents !== 'number') {
      throw new BookingInputError('amountCents must be a number of cents.');
    }
    const booking = await chargeSavedWallet(
      { orders: getOrdersController(), vault: getVaultController() },
      getBookingStore(),
      id,
      { amountCents: body.amountCents },
    );
    return NextResponse.json(booking);
  } catch (err) {
    return errorResponse(err);
  }
}
