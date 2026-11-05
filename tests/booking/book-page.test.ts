import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BookPage from '@/app/book/page';
import { NewBookingForm } from '@/components/NewBookingForm';
import { getBookingStore } from '@/lib/booking/store';

/** The first element of `type` in a rendered tree (server component output, not mounted). */
function find(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, type);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
  if (node.type === type) return node as ReactElement<Record<string, unknown>>;
  return find(node.props.children, type);
}

beforeEach(() => {
  (globalThis as { __slotkeeperBookings?: unknown }).__slotkeeperBookings = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('/book page wiring', () => {
  it('gives the form the shop time zone and a default slot computed in it', () => {
    // Fixed clock: 05:30Z on 11-05 is still the evening of 11-04 in Los Angeles.
    vi.useFakeTimers({ now: new Date('2026-11-05T05:30:00Z'), toFake: ['Date'] });
    vi.stubEnv('BUSINESS_TIME_ZONE', 'America/Los_Angeles');
    const form = find(BookPage(), NewBookingForm);
    expect(form?.props).toMatchObject({ timeZone: 'America/Los_Angeles', defaultStartsAt: '2026-11-05T10:00' });
  });

  it('follows BUSINESS_TIME_ZONE when the page is served', () => {
    vi.useFakeTimers({ now: new Date('2026-11-05T05:30:00Z'), toFake: ['Date'] });
    vi.stubEnv('BUSINESS_TIME_ZONE', 'UTC');
    expect(find(BookPage(), NewBookingForm)?.props).toMatchObject({ timeZone: 'UTC', defaultStartsAt: '2026-11-06T10:00' });
  });

  it('starts at the next free time when 10:00 tomorrow is taken', () => {
    vi.useFakeTimers({ now: new Date('2026-11-05T05:30:00Z'), toFake: ['Date'] });
    vi.stubEnv('BUSINESS_TIME_ZONE', 'America/Los_Angeles');
    // A held haircut with Maria (the only haircut staff) at 10:00-10:45 Los Angeles time on 11-05.
    getBookingStore().save({
      id: 'taken',
      serviceId: 'haircut',
      customerName: 'Ana',
      startsAt: '2026-11-05T18:00:00.000Z',
      deposit: { currency: 'USD', cents: 1000 },
      status: 'deposit_held',
      createdAt: '2026-11-05T05:00:00.000Z',
      staffId: 'maria',
    });
    expect(find(BookPage(), NewBookingForm)?.props).toMatchObject({ defaultStartsAt: '2026-11-05T11:00' });
  });
});
