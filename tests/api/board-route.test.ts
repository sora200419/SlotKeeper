import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as boardRoute } from '@/app/api/staff/board/route';
import { GET as eventsRoute } from '@/app/api/bookings/events/route';
import { POST as createRoute } from '@/app/api/bookings/route';
import { getBookingStore, type Booking } from '@/lib/booking/store';

const STAFF = 'staff-token-for-tests';
const HASH = 'token-hash-that-must-stay-on-the-server';
const headers = { Authorization: `Bearer ${STAFF}` };

const booking = (id: string): Booking => ({
  id,
  serviceId: 'haircut',
  customerName: 'Ana',
  startsAt: '2026-11-02T10:00:00.000Z',
  deposit: { currency: 'USD', cents: 1000 },
  status: 'awaiting_deposit',
  createdAt: '2026-11-01T10:00:00.000Z',
  source: 'agent',
  accessTokenHash: HASH,
});

beforeEach(() => {
  vi.stubEnv('STAFF_API_TOKEN', STAFF);
  vi.stubEnv('BUSINESS_TIME_ZONE', 'America/Los_Angeles');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/staff/board', () => {
  it('is staff-only', async () => {
    expect((await boardRoute(new Request('http://app.test/api/staff/board'))).status).toBe(401);
  });

  it('returns staff, services, the time zone and bookings, without the booking token hash', async () => {
    getBookingStore().save(booking('board-1'));
    const res = await boardRoute(new Request('http://app.test/api/staff/board', { headers }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(HASH);
    const body = JSON.parse(text);
    expect(body.timeZone).toBe('America/Los_Angeles');
    expect(body.staff).toContainEqual({ id: 'maria', name: 'Maria' });
    expect(body.services).toContainEqual({ id: 'haircut', name: 'Haircut', durationMinutes: 45 });
    expect(body.bookings.map((b: Booking) => b.id)).toContain('board-1');
    expect(body.unsavedWrites).toBe(0);
  });
});

describe('GET /api/bookings/events', () => {
  it('never sends the booking token hash', async () => {
    const abort = new AbortController();
    const res = await eventsRoute(new Request('http://app.test/api/bookings/events', { headers, signal: abort.signal }));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ": connected"
    getBookingStore().save(booking('sse-1'));
    const chunk = decoder.decode((await reader.read()).value);
    expect(chunk).toContain('sse-1');
    expect(chunk).not.toContain(HASH);
    abort.abort();
  });

  it('the heartbeat reports how many writes are waiting, so an open board can warn', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const writes = await import('@/lib/storage/records');
    let refuse = true;
    await writes.connectStorage({
      query: async (sql) => {
        if (sql.startsWith('INSERT') && refuse) throw new Error('database down');
        return { rows: sql.startsWith('INSERT') ? [{ revision: 1 }] : [] };
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const abort = new AbortController();
    const res = await eventsRoute(new Request('http://app.test/api/bookings/events', { headers, signal: abort.signal }));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ": connected"

    writes.persist('booking', 'stuck', {});
    vi.advanceTimersByTime(10_000);
    expect(decoder.decode((await reader.read()).value)).toBe('event: storage\ndata: {"unsavedWrites":1}\n\n');

    refuse = false;
    await writes.flushWrites(2000);
    vi.advanceTimersByTime(10_000);
    expect(decoder.decode((await reader.read()).value)).toBe('event: storage\ndata: {"unsavedWrites":0}\n\n');

    abort.abort();
    vi.useRealTimers();
    vi.restoreAllMocks();
    writes.resetStorage();
  });
});

describe('POST /api/bookings', () => {
  it.each([
    ['a NUL', 'A\u0000B'],
    ['half a surrogate pair', 'A\ud83d'],
    ['a line break', 'A\nB'],
  ])('refuses a customer name with %s', async (_name, customerName) => {
    const res = await createRoute(
      new Request('http://app.test/api/bookings', {
        method: 'POST',
        body: JSON.stringify({ serviceId: 'haircut', customerName, startsAt: '2099-01-01T10:00:00.000Z' }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: expect.stringContaining('not allowed') });
  });
});
