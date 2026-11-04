import { describe, expect, it } from 'vitest';
import { CopilotError } from '@/lib/copilot/copilot';
import { createCopilotGate, DEFAULT_COPILOT_DAILY_LIMIT, readCopilotDailyLimit } from '@/lib/copilot/limit';

// Fixed clock: tests never depend on the real date.
const T0 = Date.parse('2026-11-04T12:00:00Z');
const HOUR = 60 * 60 * 1000;

describe('createCopilotGate', () => {
  it('lets the limit through, then refuses with a 429 that names the limit', () => {
    const gate = createCopilotGate(2);
    gate.take(T0);
    gate.take(T0 + HOUR);
    let error: unknown;
    try {
      gate.take(T0 + 2 * HOUR);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(CopilotError);
    expect(error).toMatchObject({ code: 'rate_limited', httpStatus: 429, message: expect.stringContaining('2 requests per 24 hours') });
  });

  it('frees a slot once the oldest request is 24 hours old, and a refusal is not counted', () => {
    const gate = createCopilotGate(2);
    gate.take(T0);
    gate.take(T0 + HOUR);
    expect(() => gate.take(T0 + 23 * HOUR)).toThrow(CopilotError);
    expect(() => gate.take(T0 + 24 * HOUR)).not.toThrow();
    // T0 + HOUR and T0 + 24h count now; the refused request at 23h did not.
    expect(() => gate.take(T0 + 24 * HOUR + 1)).toThrow(CopilotError);
    expect(() => gate.take(T0 + 25 * HOUR)).not.toThrow();
  });
});

describe('readCopilotDailyLimit', () => {
  it('defaults to 40 when unset or blank', () => {
    expect(readCopilotDailyLimit({})).toBe(40);
    expect(readCopilotDailyLimit({ COPILOT_DAILY_LIMIT: '  ' })).toBe(40);
    expect(DEFAULT_COPILOT_DAILY_LIMIT).toBe(40);
  });

  it('takes a whole number from 1 to 1000', () => {
    expect(readCopilotDailyLimit({ COPILOT_DAILY_LIMIT: '1' })).toBe(1);
    expect(readCopilotDailyLimit({ COPILOT_DAILY_LIMIT: ' 25 ' })).toBe(25);
    expect(readCopilotDailyLimit({ COPILOT_DAILY_LIMIT: '1000' })).toBe(1000);
  });

  it.each(['0', '-5', '1001', '2.5', '10x', 'many', '1e3'])('stops the copilot loudly for %j', (value) => {
    expect(() => readCopilotDailyLimit({ COPILOT_DAILY_LIMIT: value })).toThrow(/COPILOT_DAILY_LIMIT must be a whole number from 1 to 1000/);
  });
});
