import { NextResponse } from 'next/server';
import { getWebBookingLimiter } from '@/lib/agent/rate-limit';
import { clientKey } from '@/lib/api/client-key';
import { errorResponse, readJsonObject } from '@/lib/api/responses';
import { blocks, freeStaffFor, searchSlots } from '@/lib/booking/availability';
import { BookingInputError, createBooking, MAX_UNPAID_WEB_HOLDS, SLOT_UNAVAILABLE_MESSAGE } from '@/lib/booking/bookings';
import { businessDay } from '@/lib/booking/earnings';
import { withBookingLock } from '@/lib/booking/locks';
import { getBookingStore, type BookingStore } from '@/lib/booking/store';
import { readBusinessTimeZone } from '@/lib/paypal/payout-deps';

export const runtime = 'nodejs';

/** Up to three free start times on the requested day, in shop time, to put in the refusal. */
function freeTimesHint(store: BookingStore, serviceId: unknown, startsAt: unknown, timeZone: string, now: Date): string {
  if (typeof serviceId !== 'string' || typeof startsAt !== 'string' || Number.isNaN(Date.parse(startsAt))) return '';
  const day = businessDay(new Date(startsAt), timeZone);
  const format = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const times = [...new Set(searchSlots(store.list(), serviceId, day, timeZone, now).map((s) => format.format(new Date(s.startsAt))))];
  if (times.length === 0) return ' No free times that day; try another day.';
  return ` Free that day: ${times.slice(0, 3).join(', ')}.`;
}

/**
 * Creates a booking awaiting its deposit. The price comes from the catalog, never the request.
 * The time must be a free slot (opening hours, half-hour grid, staff not busy), checked and claimed
 * under the same 'slots' lock as the MCP hold, so two customers can't take one staff member's time.
 */
export async function POST(request: Request) {
  try {
    const body = await readJsonObject(request);
    const timeZone = readBusinessTimeZone();
    const store = getBookingStore();
    const result = await withBookingLock(
      'slots',
      async () => {
        const now = new Date();
        if (!getWebBookingLimiter().take(clientKey(request), now.getTime())) return { limited: 'client' as const };
        const unpaidWeb = store.list().filter((b) => b.source !== 'agent' && b.status === 'awaiting_deposit' && blocks(b, now));
        if (unpaidWeb.length >= MAX_UNPAID_WEB_HOLDS) return { limited: 'shop' as const };
        try {
          const booking = createBooking(
            store,
            { serviceId: body.serviceId, customerName: body.customerName, startsAt: body.startsAt },
            now,
            (serviceId, startsAt) => freeStaffFor(store, serviceId, startsAt, timeZone, now),
          );
          return { booking };
        } catch (err) {
          if (err instanceof BookingInputError && err.message === SLOT_UNAVAILABLE_MESSAGE) {
            throw new BookingInputError(SLOT_UNAVAILABLE_MESSAGE + freeTimesHint(store, body.serviceId, body.startsAt, timeZone, now));
          }
          throw err;
        }
      },
      'wait',
    );
    if ('limited' in result) {
      const message =
        result.limited === 'client'
          ? 'Too many booking attempts from your connection; please wait a few minutes.'
          : 'Too many unpaid bookings right now; please try again in a few minutes.';
      return NextResponse.json({ error: 'rate_limited', message }, { status: 429 });
    }
    return NextResponse.json(result.booking, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
