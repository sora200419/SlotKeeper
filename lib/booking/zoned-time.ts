// Pure and browser-safe: the booking form uses these as well as server pages.

// Years 1000-9999 only: Date.UTC maps 0-99 to 1900-1999. Hours 00-23, minutes and seconds 00-59.
const WALL = /^([1-9]\d{3})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export class ZonedTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZonedTimeError';
  }
}

/** The wall-clock time of an instant in `timeZone`, as if it were UTC (ms). */
function wallMs(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  );
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
}

/**
 * A wall-clock time typed into a datetime-local field ("2026-11-05T10:00"), read in `timeZone`
 * (not the browser's zone), as a UTC ISO instant. When clocks go back, a time that happens twice is
 * read as the first one; a time skipped when clocks go forward is refused.
 */
export function zonedWallTimeToUtc(wall: string, timeZone: string): string {
  const m = WALL.exec(wall);
  if (!m) throw new ZonedTimeError('Pick a date and time.');
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  if (Number.isNaN(asUtc) || new Date(asUtc).getUTCDate() !== +m[3]) throw new ZonedTimeError('Pick a valid date.');
  // A zone changes its offset at most once a day, so the offsets a day either side cover every case.
  const offsets = new Set([wallMs(asUtc - DAY_MS, timeZone) - (asUtc - DAY_MS), wallMs(asUtc + DAY_MS, timeZone) - (asUtc + DAY_MS)]);
  const matches = [...offsets]
    .map((offset) => asUtc - offset)
    .filter((instant) => wallMs(instant, timeZone) === asUtc)
    .sort((a, b) => a - b);
  if (matches.length === 0) throw new ZonedTimeError('That time does not exist here (the clocks skip it). Pick another time.');
  return new Date(matches[0]).toISOString();
}

/**
 * The POST /api/bookings body the booking form sends: the typed time is shop time in `timeZone`,
 * sent as a UTC instant. Kept here, outside the component, so the conversion is tested.
 */
export function newBookingBody(
  fields: { serviceId: unknown; customerName: unknown; startsAt: unknown },
  timeZone: string,
): { serviceId: unknown; customerName: unknown; startsAt: string } {
  return { serviceId: fields.serviceId, customerName: fields.customerName, startsAt: zonedWallTimeToUtc(String(fields.startsAt ?? ''), timeZone) };
}

/** "2026-11-04": the date in `timeZone` at `now`. */
function dateIn(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The form's default: tomorrow at 10:00 in the business time zone, as a datetime-local value. */
export function defaultSlotIn(now: Date, timeZone: string): string {
  const tomorrow = new Date(Date.parse(`${dateIn(now, timeZone)}T12:00:00Z`) + DAY_MS);
  return `${tomorrow.toISOString().slice(0, 10)}T10:00`;
}

/** An instant for people to read in the business zone: "Thursday, November 5, 2026, 10:00 PST (America/Los_Angeles)". */
export function formatInZone(iso: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.weekday}, ${parts.month} ${parts.day}, ${parts.year}, ${parts.hour}:${parts.minute} ${parts.timeZoneName} (${timeZone})`;
}
