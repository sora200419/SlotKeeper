import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as moveRoute } from '@/app/api/bookings/[id]/move/route';
import { POST as createRoute } from '@/app/api/bookings/route';
import { withBookingLock } from '@/lib/booking/locks';
import { getBookingStore, type Booking } from '@/lib/booking/store';

// Fixed clock: 2026-11-05 08:00 in Los Angeles. Haircut (45 min) is Maria only; physio (60 min) is Ken only.
const NOW = new Date('2026-11-05T16:00:00Z');
const TOKEN = 'move-test-token';
const at = (laTime: string) => new Date(`2026-11-05T${laTime}:00-08:00`).toISOString();

function booking(id: string, overrides: Partial<Booking> = {}): Booking {
  return {
    id,
    serviceId: 'haircut',
    customerName: id,
    startsAt: at('10:00'),
    deposit: { currency: 'USD', cents: 1000 },
    status: 'deposit_held',
    createdAt: NOW.toISOString(),
    staffId: 'maria',
    hold: {
      paypalOrderId: `order-${id}`,
      orderAttempt: 1,
      orderCreatedAt: NOW.toISOString(),
      authorizationId: `auth-${id}`,
      heldAt: NOW.toISOString(),
    },
    ...overrides,
  };
}

function move(id: string, body: unknown, token: string | null = TOKEN) {
  return moveRoute(
    new Request(`http://app.test/api/bookings/${id}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  (globalThis as { __slotkeeperBookings?: unknown }).__slotkeeperBookings = undefined;
  (globalThis as { __slotkeeperWebBookingLimiter?: unknown }).__slotkeeperWebBookingLimiter = undefined;
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  vi.stubEnv('BUSINESS_TIME_ZONE', 'America/Los_Angeles');
  vi.stubEnv('STAFF_API_TOKEN', TOKEN);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('POST /api/bookings/[id]/move (drag on the board)', () => {
  it('needs the staff token', async () => {
    getBookingStore().save(booking('a'));
    expect((await move('a', { startsAt: at('11:00') }, null)).status).toBe(401);
    expect((await move('a', { startsAt: at('11:00') }, 'wrong')).status).toBe(401);
    expect(getBookingStore().get('a')?.startsAt).toBe(at('10:00'));
  });

  it('moves a held booking to a free time and keeps the deposit held', async () => {
    getBookingStore().save(booking('a'));
    const res = await move('a', { startsAt: at('11:30'), staffId: 'maria' });
    expect(res.status).toBe(200);
    expect(getBookingStore().get('a')).toMatchObject({ startsAt: at('11:30'), staffId: 'maria', status: 'deposit_held' });
  });

  it('allows a small move that overlaps only the booking itself', async () => {
    getBookingStore().save(booking('a'));
    expect((await move('a', { startsAt: at('10:30') })).status).toBe(200);
  });

  it.each([
    ['onto another booking', at('11:00'), 'maria'],
    ['outside opening hours', at('17:30'), 'maria'],
    ['off the half-hour grid', at('11:15'), 'maria'],
  ])('refuses a move %s', async (_label, startsAt, staffId) => {
    getBookingStore().save(booking('a'));
    getBookingStore().save(booking('b', { startsAt: at('11:00') }));
    const res = await move('a', { startsAt, staffId });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: expect.stringContaining('not free') });
    expect(getBookingStore().get('a')?.startsAt).toBe(at('10:00'));
  });

  it('refuses a staff member who does not do the service', async () => {
    getBookingStore().save(booking('a'));
    const res = await move('a', { staffId: 'ken' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: expect.stringContaining('does not do Haircut') });
    expect(getBookingStore().get('a')?.staffId).toBe('maria');
  });

  it('refuses to move a booking that is finished', async () => {
    getBookingStore().save(booking('a', { status: 'completed' }));
    const res = await move('a', { startsAt: at('11:30') });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: expect.stringContaining("can't be moved") });
  });

  it('waits for a deposit being authorized on the target slot, then refuses the drag', async () => {
    getBookingStore().save(booking('a'));
    // Y's unpaid claim on 13:00 has lapsed, so it does not block; its customer approves the old PayPal link
    // and authorize holds the slots lock across the PayPal call (lib/paypal/deposits.ts), then marks Y held.
    const lapsed = booking('y', { status: 'awaiting_deposit', startsAt: at('13:00'), createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString() });
    getBookingStore().save(lapsed);
    let release!: () => void;
    const paypalAnswers = new Promise<void>((resolve) => (release = resolve));
    const authorize = withBookingLock(
      'slots',
      async () => {
        await paypalAnswers;
        getBookingStore().save({ ...lapsed, status: 'deposit_held' });
      },
      'wait',
    );
    const dragged = move('a', { startsAt: at('13:00') });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await authorize;
    const res = await dragged;
    expect(res.status).toBe(400);
    expect(getBookingStore().get('a')?.startsAt).toBe(at('10:00'));
    expect(getBookingStore().get('y')?.status).toBe('deposit_held');
  });

  it('does not let a drag and a customer booking take the same slot', async () => {
    getBookingStore().save(booking('a'));
    const [dragged, booked] = await Promise.all([
      move('a', { startsAt: at('13:00') }),
      createRoute(
        new Request('http://app.test/api/bookings', {
          method: 'POST',
          body: JSON.stringify({ serviceId: 'haircut', customerName: 'Walk-in', startsAt: at('13:00') }),
        }),
      ),
    ]);
    // Whichever gets the slots lock first wins (drag 200 or booking 201); the other is refused with 400.
    const statuses = [dragged.status, booked.status];
    expect(statuses.filter((s) => s === 200 || s === 201)).toHaveLength(1);
    expect(statuses).toContain(400);
    const atOne = getBookingStore()
      .list()
      .filter((b) => b.startsAt === at('13:00'));
    expect(atOne).toHaveLength(1);
  });
});
