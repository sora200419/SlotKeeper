import 'server-only';
import { createRateLimiter } from '@/lib/agent/rate-limit';
import { CopilotError } from './copilot';

/**
 * A cap on copilot requests across all callers, so a small Anthropic balance cannot be used up by
 * repeated clicks (the staff token is the only other gate). The count lives in memory: a restart or a
 * deploy starts it from zero, and the balance itself stays the hard limit.
 */
export const DEFAULT_COPILOT_DAILY_LIMIT = 40;
const MAX_COPILOT_DAILY_LIMIT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** COPILOT_DAILY_LIMIT: whole requests per rolling 24 hours; unset means the default, a bad value stops the copilot, loudly. */
export function readCopilotDailyLimit(env: Record<string, string | undefined> = process.env): number {
  const raw = env.COPILOT_DAILY_LIMIT?.trim();
  if (!raw) return DEFAULT_COPILOT_DAILY_LIMIT;
  const limit = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_COPILOT_DAILY_LIMIT) {
    throw new CopilotError('missing_config', 500, `COPILOT_DAILY_LIMIT must be a whole number from 1 to ${MAX_COPILOT_DAILY_LIMIT}.`);
  }
  return limit;
}

export function createCopilotGate(limit: number, windowMs: number = DAY_MS) {
  const limiter = createRateLimiter({ limit, windowMs, maxKeys: 1 });
  return {
    /** Counts one request; throws a 429 CopilotError when the limit for the window is used up. */
    take(now: number = Date.now()): void {
      if (!limiter.take('copilot', now)) {
        throw new CopilotError('rate_limited', 429, `The copilot is limited to ${limit} requests per 24 hours to protect the AI budget. Try again later.`);
      }
    },
  };
}

const state = globalThis as typeof globalThis & { __slotkeeperCopilotGate?: ReturnType<typeof createCopilotGate> };

/** One shared gate per process, sized from COPILOT_DAILY_LIMIT when first used. */
export function takeCopilotRequest(now: number = Date.now()): void {
  state.__slotkeeperCopilotGate ??= createCopilotGate(readCopilotDailyLimit());
  state.__slotkeeperCopilotGate.take(now);
}
