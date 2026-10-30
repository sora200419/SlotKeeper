import 'server-only';
import { businessDay } from '@/lib/booking/earnings';
import { readPayoutEmails } from '@/lib/booking/staff';
import { getBookingStore } from '@/lib/booking/store';
import { getAccessToken, restBaseUrl } from './client';
import { PayPalConfigError, readPayPalSettings } from './config';
import { getPayoutStore, type PayoutDeps } from './payouts';
import { createRestTransport } from './rest';

/** BUSINESS_TIME_ZONE (IANA, e.g. America/Los_Angeles) decides what "today" is for payouts. */
export function readBusinessTimeZone(env: Record<string, string | undefined> = process.env): string {
  const zone = env.BUSINESS_TIME_ZONE?.trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
  } catch {
    throw new PayPalConfigError(`BUSINESS_TIME_ZONE "${zone}" is not a valid IANA time zone.`, ['BUSINESS_TIME_ZONE']);
  }
  return zone;
}

export function getPayoutDeps(): PayoutDeps {
  return {
    rest: createRestTransport({
      baseUrl: restBaseUrl(),
      getToken: getAccessToken,
      timeoutMs: readPayPalSettings().timeoutMs,
    }),
    bookings: getBookingStore(),
    payouts: getPayoutStore(),
    emails: readPayoutEmails(),
    timeZone: readBusinessTimeZone(),
  };
}

/** The last business day that is over: what the end-of-day job pays by default. */
export function yesterdayInBusinessZone(now: Date = new Date()): string {
  const today = businessDay(now, readBusinessTimeZone());
  // Calendar arithmetic on the date itself (noon UTC avoids any DST edge).
  const previous = new Date(Date.parse(`${today}T12:00:00Z`) - 24 * 60 * 60 * 1000);
  return previous.toISOString().slice(0, 10);
}
