import 'server-only';
import { MAX_DAYS_AHEAD } from './bookings';
import { findService } from './catalog';
import { businessDay } from './earnings';
import { defaultStaffFor, listStaff } from './staff';
import type { Booking, BookingStore } from './store';

/** Demo opening hours in the business time zone, every day, until the scheduler manages them. */
export const OPEN_MINUTE = 9 * 60;
export const CLOSE_MINUTE = 18 * 60;
const STEP_MINUTES = 30;
/** Customers (and their assistants) can't book the very next minutes. */
const LEAD_MS = 30 * 60 * 1000;
/** An unpaid booking keeps its slot this long; then it stops blocking others. */
export const UNPAID_HOLD_MS = 30 * 60 * 1000;

const ACTIVE = new Set(['awaiting_deposit', 'deposit_held', 'deposit_pending', 'deposit_needs_review']);

export interface Slot {
  startsAt: string;
  staffId: string;
}

/** Local minutes after midnight of an instant in `timeZone`. */
function localMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return value('hour') * 60 + value('minute');
}

/**
 * When an unpaid booking's claim on its slot lapses: 30 minutes from the last claim (renewed when its
 * deposit is started again), and never later than an hour after the booking was made.
 */
export function unpaidHoldEnds(booking: Booking): number {
  const claimed = Date.parse(booking.slotHeldAt ?? booking.createdAt) + UNPAID_HOLD_MS;
  return Math.min(claimed, Date.parse(booking.createdAt) + 2 * UNPAID_HOLD_MS);
}

/** Does this booking still occupy its staff member's time? */
export function blocks(booking: Booking, now: Date): boolean {
  if (!ACTIVE.has(booking.status)) return false;
  if (booking.status === 'awaiting_deposit') return now.getTime() < unpaidHoldEnds(booking);
  return true;
}

/**
 * Another booking that holds the same staff member at an overlapping time, if any. Checked before a
 * deposit is placed, so two customers can never both pay for one slot (e.g. an unpaid hold lapsed,
 * someone else took the slot, then the first customer approved their old PayPal link).
 */
export function slotConflict(bookings: readonly Booking[], booking: Booking, now: Date): Booking | undefined {
  const staffId = booking.staffId ?? defaultStaffFor(booking.serviceId)?.id;
  const start = Date.parse(booking.startsAt);
  const end = start + durationMs(booking.serviceId);
  return bookings.find(
    (other) =>
      other.id !== booking.id &&
      (other.staffId ?? defaultStaffFor(other.serviceId)?.id) === staffId &&
      blocks(other, now) &&
      overlaps(start, end, other),
  );
}

function durationMs(serviceId: string): number {
  return (findService(serviceId)?.durationMinutes ?? 60) * 60 * 1000;
}

function overlaps(startMs: number, endMs: number, booking: Booking): boolean {
  const otherStart = Date.parse(booking.startsAt);
  return startMs < otherStart + durationMs(booking.serviceId) && otherStart < endMs;
}

/** Staff who can do a service: whoever does it by default. */
function staffFor(serviceId: string): string[] {
  return listStaff()
    .filter((s) => s.services.includes(serviceId))
    .map((s) => s.id);
}

/**
 * Free start times for a service on one business day: inside opening hours, at least 30 minutes from
 * now, at most MAX_DAYS_AHEAD days ahead (the deposit hold's honor period), and not overlapping the
 * staff member's active bookings.
 */
export function searchSlots(
  bookings: readonly Booking[],
  serviceId: string,
  day: string,
  timeZone: string,
  now: Date,
): Slot[] {
  const service = findService(serviceId);
  if (!service) return [];
  const length = service.durationMinutes;
  const busy = bookings.filter((b) => blocks(b, now));
  const latest = now.getTime() + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000;
  const slots: Slot[] = [];
  // Walk the UTC instants that can fall on `day` in any zone, every 15 minutes (so zones with :30 and
  // :45 offsets work too), and keep the ones on the local half-hour grid of that day.
  const from = Date.parse(`${day}T00:00:00Z`) - 14 * 60 * 60 * 1000;
  const to = Date.parse(`${day}T00:00:00Z`) + 38 * 60 * 60 * 1000;
  for (let t = from; t < to; t += 15 * 60 * 1000) {
    const instant = new Date(t);
    if (businessDay(instant, timeZone) !== day) continue;
    const minute = localMinutes(instant, timeZone);
    if (minute % STEP_MINUTES !== 0) continue;
    if (minute < OPEN_MINUTE || minute + length > CLOSE_MINUTE) continue;
    if (t < now.getTime() + LEAD_MS || t > latest) continue;
    const end = t + length * 60 * 1000;
    for (const staffId of staffFor(serviceId)) {
      const taken = busy.some(
        (b) => (b.staffId ?? defaultStaffFor(b.serviceId)?.id) === staffId && overlaps(t, end, b),
      );
      if (!taken) slots.push({ startsAt: instant.toISOString(), staffId });
    }
  }
  return slots;
}

/** Is this exact start time free for this service right now? Returns the staff member who can take it. */
export function freeStaffFor(store: BookingStore, serviceId: string, startsAt: string, timeZone: string, now: Date): string | undefined {
  const ms = Date.parse(startsAt);
  if (Number.isNaN(ms)) return undefined;
  const day = businessDay(new Date(ms), timeZone);
  return searchSlots(store.list(), serviceId, day, timeZone, now).find((s) => Date.parse(s.startsAt) === ms)?.staffId;
}
