import { describe, expect, it } from 'vitest';
import { auditTime } from '@/components/CopilotPanel';

describe('audit log times are shop time, not the viewer\'s browser zone', () => {
  it('shows a UTC instant in Los Angeles time with its zone, in winter and summer', () => {
    // 2026-11-05T04:05Z is still 4 November in Los Angeles (PST, UTC-8).
    expect(auditTime('2026-11-05T04:05:00.000Z', 'America/Los_Angeles')).toBe('Nov 4, 2026, 20:05 PST');
    expect(auditTime('2026-10-20T17:30:00.000Z', 'America/Los_Angeles')).toBe('Oct 20, 2026, 10:30 PDT');
  });

  it('follows the configured zone', () => {
    expect(auditTime('2026-11-05T04:05:00.000Z', 'UTC')).toBe('Nov 5, 2026, 04:05 UTC');
  });
});
