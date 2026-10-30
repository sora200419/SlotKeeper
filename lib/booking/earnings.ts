import 'server-only';
import { defaultStaffFor, findStaff } from './staff';
import type { Booking } from './store';

export interface StaffEarnings {
  staffId: string;
  /** Money the business kept that day from this person's bookings: captures + wallet charges − refunds. */
  netCents: number;
  commissionCents: number;
  tipCents: number;
  /** What to pay out: commission + tips. Can be ≤ 0 on a day of refunds; such days are not paid. */
  totalCents: number;
  bookingIds: string[];
}

/** The calendar day (YYYY-MM-DD) of an instant in the business's time zone. */
export function businessDay(instant: string | Date, timeZone: string): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    typeof instant === 'string' ? new Date(instant) : instant,
  );
}

const SETTLED = 'COMPLETED';

/**
 * Each staff member's earnings for one business day. Money counts on the day it completed: a
 * completed capture or wallet charge adds, a completed refund subtracts. Money that was PENDING
 * counts on the day it later completed (`settledAt`), so it lands in a later day's payout. A refund
 * after a payout lowers that later day's total; a day whose total ends up ≤ 0 is not paid and the
 * shortfall is not carried forward (commission already paid is not clawed back). Tips count on the
 * day the booking's capture completed.
 */
export function dailyEarnings(bookings: readonly Booking[], day: string, timeZone: string): StaffEarnings[] {
  const byStaff = new Map<string, { net: number; tips: number; bookingIds: Set<string> }>();
  const add = (staffId: string, bookingId: string, net: number, tips: number) => {
    const entry = byStaff.get(staffId) ?? { net: 0, tips: 0, bookingIds: new Set<string>() };
    entry.net += net;
    entry.tips += tips;
    entry.bookingIds.add(bookingId);
    byStaff.set(staffId, entry);
  };

  for (const booking of bookings) {
    const staffId = booking.staffId ?? defaultStaffFor(booking.serviceId)?.id;
    const hold = booking.hold;
    if (!staffId || !hold) continue;
    const onDay = (instant: string) => businessDay(instant, timeZone) === day;

    const capture = hold.capture;
    if (capture?.status === SETTLED && onDay(capture.settledAt ?? capture.capturedAt)) {
      add(staffId, booking.id, capture.amountCents, booking.tipCents ?? 0);
    }
    for (const charge of hold.walletCharges ?? []) {
      if (charge.status === SETTLED && onDay(charge.settledAt ?? charge.chargedAt)) {
        add(staffId, booking.id, charge.amountCents, 0);
      }
    }
    for (const refund of hold.refunds ?? []) {
      if (refund.status === SETTLED && onDay(refund.settledAt ?? refund.refundedAt)) {
        add(staffId, booking.id, -refund.amountCents, 0);
      }
    }
  }

  return [...byStaff.entries()]
    .map(([staffId, entry]) => {
      const rate = findStaff(staffId)?.commissionBps ?? 0;
      const commissionCents = Math.round((entry.net * rate) / 10_000);
      return {
        staffId,
        netCents: entry.net,
        commissionCents,
        tipCents: entry.tips,
        totalCents: commissionCents + entry.tips,
        bookingIds: [...entry.bookingIds].sort(),
      };
    })
    .sort((a, b) => a.staffId.localeCompare(b.staffId));
}
