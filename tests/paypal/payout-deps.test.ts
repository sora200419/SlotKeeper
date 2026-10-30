import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBusinessTimeZone, yesterdayInBusinessZone } from '@/lib/paypal/payout-deps';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('readBusinessTimeZone', () => {
  it('defaults to UTC and accepts IANA zones', () => {
    expect(readBusinessTimeZone({})).toBe('UTC');
    expect(readBusinessTimeZone({ BUSINESS_TIME_ZONE: ' America/Los_Angeles ' })).toBe('America/Los_Angeles');
  });

  it('rejects an invalid zone as a config error', () => {
    expect(() => readBusinessTimeZone({ BUSINESS_TIME_ZONE: 'Mars/Olympus' })).toThrow(
      expect.objectContaining({ name: 'PayPalConfigError', missing: ['BUSINESS_TIME_ZONE'] }),
    );
  });
});

describe('yesterdayInBusinessZone', () => {
  it('is the previous calendar day in the business zone, around local midnight', () => {
    vi.stubEnv('BUSINESS_TIME_ZONE', 'America/Los_Angeles');
    // 23:59 on Nov 1 in LA (PST starts Nov 1, 2026: UTC-8) → yesterday is Oct 31.
    expect(yesterdayInBusinessZone(new Date('2026-11-02T07:59:00.000Z'))).toBe('2026-10-31');
    // 00:01 on Nov 2 in LA → yesterday is Nov 1.
    expect(yesterdayInBusinessZone(new Date('2026-11-02T08:01:00.000Z'))).toBe('2026-11-01');
  });

  it('handles the fall-back hour (01:00–02:00 happens twice) and month/year boundaries', () => {
    vi.stubEnv('BUSINESS_TIME_ZONE', 'America/Los_Angeles');
    // Nov 1, 2026: 01:30 PDT (08:30Z) and, an hour later, 01:30 PST again (09:30Z). Both are Nov 1.
    expect(yesterdayInBusinessZone(new Date('2026-11-01T08:30:00.000Z'))).toBe('2026-10-31');
    expect(yesterdayInBusinessZone(new Date('2026-11-01T09:30:00.000Z'))).toBe('2026-10-31');
    vi.stubEnv('BUSINESS_TIME_ZONE', 'UTC');
    expect(yesterdayInBusinessZone(new Date('2027-01-01T00:30:00.000Z'))).toBe('2026-12-31');
    expect(yesterdayInBusinessZone(new Date('2028-03-01T09:00:00.000Z'))).toBe('2028-02-29');
  });
});
