import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as createRoute } from '@/app/api/bookings/route';
import { MAX_UNPAID_WEB_HOLDS, SLOT_UNAVAILABLE_MESSAGE } from '@/lib/booking/bookings';
import { getBookingStore, type Booking } from '@/lib/booking/store';

// Fixed clock: 2026-11-05 08:00 in Los Angeles (16:00Z). Haircut is 45 minutes and only Maria does it.
const NOW = new Date('2026-11-05T16:00:00Z');
const LA = 'America/Los_Angeles';

function book(startsAt: string, customerName = 'Ana', serviceId = 'haircut', client = '203.0.113.1') {
  return createRoute(
    new Request('http://app.test/api/bookings', {
      method: 'POST',
      headers: { 'x-forwarded-for': client },
      body: JSON.stringify({ serviceId, customerName, startsAt }),
    }),
  );
}

beforeEach(() => {
  (globalThis as { __slotkeeperBookings?: unknown }).__slotkeeperBookings = undefined;
  (globalThis as { __slotkeeperWebBookingLimiter?: unknown }).__slotkeeperWebBookingLimiter = undefined;
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  vi.stubEnv('BUSINESS_TIME_ZONE', LA);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('POST /api/bookings checks the slot like the MCP hold does', () => {
  it('books a free slot in opening hours and assigns the staff member who is free', async () => {
    const res = await book('2026-11-05T18:00:00.000Z'); // 10:00 in Los Angeles
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; staffId: string };
    expect(created.staffId).toBe('maria');
    expect(getBookingStore().get(created.id)).toMatchObject({ status: 'awaiting_deposit', staffId: 'maria' });
  });

  it.each([
    ['before opening (8:30)', '2026-11-05T16:30:00.000Z'],
    ['ending after closing (17:30 + 45 min)', '2026-11-06T01:30:00.000Z'],
    ['in the evening (19:00)', '2026-11-06T03:00:00.000Z'],
    ['off the half-hour grid (10:15)', '2026-11-05T18:15:00.000Z'],
  ])('refuses a time %s', async (_label, startsAt) => {
    const res = await book(startsAt);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: expect.stringContaining(SLOT_UNAVAILABLE_MESSAGE) });
    expect(getBookingStore().list()).toHaveLength(0);
  });

  it('refuses a second booking that overlaps the same staff member', async () => {
    expect((await book('2026-11-05T18:00:00.000Z', 'Ana')).status).toBe(201);
    // 10:30 overlaps Ana's 10:00-10:45 haircut with Maria.
    const res = await book('2026-11-05T18:30:00.000Z', 'Ben');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: expect.stringContaining(SLOT_UNAVAILABLE_MESSAGE) });
    expect(getBookingStore().list().map((b) => b.customerName)).toEqual(['Ana']);
  });

  it('lets only one of two simultaneous requests take the same slot', async () => {
    const [a, b] = await Promise.all([book('2026-11-05T19:00:00.000Z', 'Ana'), book('2026-11-05T19:00:00.000Z', 'Ben')]);
    expect([a.status, b.status].sort()).toEqual([201, 400]);
    expect(getBookingStore().list()).toHaveLength(1);
  });

  it('still reports bad input before the slot check', async () => {
    const res = await book('2026-11-05T18:00:00.000Z', 'A\nB');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: expect.stringContaining('not allowed') });
  });

  it('names free times that day in shop time when a time is refused', async () => {
    expect((await book('2026-11-05T18:00:00.000Z', 'Ana')).status).toBe(201);
    // Maria is busy 10:00-10:45; 9:30 and 10:30 would overlap. Times are Los Angeles wall clock.
    const res = await book('2026-11-05T18:30:00.000Z', 'Ben');
    expect(((await res.json()) as { message: string }).message).toBe(`${SLOT_UNAVAILABLE_MESSAGE} Free that day: 09:00, 11:00, 11:30.`);
  });
});

describe('POST /api/bookings limits each client', () => {
  it('refuses a client after 10 attempts in 10 minutes, while another client still books', async () => {
    // Attempts count whether or not they succeed: the first takes 10:00, the rest are refused as taken.
    for (let i = 0; i < 10; i++) await book('2026-11-05T18:00:00.000Z', `A${i}`, 'haircut', '203.0.113.1');
    const limited = await book('2026-11-05T20:00:00.000Z', 'A10', 'haircut', '203.0.113.1');
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: 'rate_limited', message: expect.stringContaining('your connection') });
    expect((await book('2026-11-05T20:00:00.000Z', 'B', 'haircut', '198.51.100.7')).status).toBe(201);
  });

  it('counts one client once when only the last X-Forwarded-For entry (a Cloudflare hop) changes, as on Render', async () => {
    const attempt = (i: number) =>
      createRoute(
        new Request('http://app.test/api/bookings', {
          method: 'POST',
          headers: { 'cf-connecting-ip': '175.141.10.20', 'x-forwarded-for': `175.141.10.20, 104.23.${i}.9` },
          body: JSON.stringify({ serviceId: 'haircut', customerName: `A${i}`, startsAt: '2026-11-05T18:00:00.000Z' }),
        }),
      );
    for (let i = 0; i < 10; i++) await attempt(i);
    expect((await attempt(10)).status).toBe(429);
  });

  it('lets the client book again once the window has passed', async () => {
    for (let i = 0; i < 10; i++) await book('2026-11-05T18:00:00.000Z', `A${i}`);
    expect((await book('2026-11-05T20:00:00.000Z', 'late')).status).toBe(429);
    vi.setSystemTime(new Date(NOW.getTime() + 11 * 60 * 1000));
    expect((await book('2026-11-05T20:00:00.000Z', 'later')).status).toBe(201);
  });
});

describe('POST /api/bookings caps unpaid web bookings', () => {
  function unpaid(id: string, source?: 'agent'): Booking {
    return {
      id,
      serviceId: 'physio',
      customerName: id,
      startsAt: '2026-11-06T18:00:00.000Z',
      deposit: { currency: 'USD', cents: 2000 },
      status: 'awaiting_deposit',
      createdAt: NOW.toISOString(),
      staffId: 'ken',
      ...(source ? { source } : {}),
    };
  }

  it(`refuses a new booking while ${MAX_UNPAID_WEB_HOLDS} unpaid web bookings block slots`, async () => {
    for (let i = 0; i < MAX_UNPAID_WEB_HOLDS; i++) getBookingStore().save(unpaid(`web-${i}`));
    const res = await book('2026-11-05T18:00:00.000Z');
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'rate_limited' });
    expect(getBookingStore().list()).toHaveLength(MAX_UNPAID_WEB_HOLDS);
  });

  it('does not count paid, lapsed or assistant bookings', async () => {
    for (let i = 0; i < MAX_UNPAID_WEB_HOLDS - 1; i++) getBookingStore().save(unpaid(`web-${i}`));
    getBookingStore().save(unpaid('agent-hold', 'agent'));
    getBookingStore().save({ ...unpaid('paid'), status: 'deposit_held' });
    // Made more than an hour ago: its claim on the slot has lapsed.
    getBookingStore().save({ ...unpaid('lapsed'), createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString() });
    expect((await book('2026-11-05T18:00:00.000Z')).status).toBe(201);
  });
});
