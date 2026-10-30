import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const searchTransactions = vi.fn();
vi.mock('@/lib/paypal/client', () => ({
  getTransactionSearchController: () => ({ searchTransactions }),
}));

import { GET } from '@/app/api/reports/transactions/route';

const TOKEN = 'staff-token-for-tests';
const get = (query: string, auth = true) =>
  GET(new Request(`http://app.test/api/reports/transactions?${query}`, { headers: auth ? { Authorization: `Bearer ${TOKEN}` } : {} }));

beforeEach(() => {
  // Fixed clock: the route uses the real time, and the fixed October range below must never age out of
  // Transaction Search's three-year window. Only Date is faked; async timers stay real.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z'));
  searchTransactions.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('STAFF_API_TOKEN', TOKEN);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('GET /api/reports/transactions', () => {
  it('is staff-only', async () => {
    expect((await get('from=2026-10-01&to=2026-10-31', false)).status).toBe(401);
    expect(searchTransactions).not.toHaveBeenCalled();
  });

  it('rejects a bad range with 400 before calling PayPal', async () => {
    const res = await get('from=2026-10-31&to=2026-10-01');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_range' });
    expect(searchTransactions).not.toHaveBeenCalled();
  });

  it('returns the report with the lag notice', async () => {
    searchTransactions.mockResolvedValue({
      result: {
        totalPages: 1,
        transactionDetails: [
          {
            transactionInfo: {
              transactionId: 'CAP-1',
              transactionInitiationDate: '2026-10-05T10:00:00+0000',
              transactionAmount: { currencyCode: 'USD', value: '10.00' },
              transactionStatus: 'S',
              invoiceId: 'bk-1-capture-1',
              customField: 'bk-1',
            },
          },
        ],
      },
    });
    const res = await get('from=2026-10-01&to=2026-10-10');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ totals: { depositsCapturedCents: 1000, netCents: 1000 }, timeZone: 'UTC' });
    expect(body.lagNotice).toContain('3 hours');
  });
});
