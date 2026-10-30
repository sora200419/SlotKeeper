import 'server-only';

/**
 * Sliding-window counter per key (e.g. client IP), in memory like the rest of the demo state.
 * Bounded: keys with no recent hits are dropped as the map is used.
 */
export function createRateLimiter(options: { limit: number; windowMs: number; maxKeys?: number }) {
  const hits = new Map<string, number[]>();
  const maxKeys = options.maxKeys ?? 10_000;
  return {
    /** Counts a hit for `key`; false if it is over the limit (the hit is then not counted). */
    take(key: string, now: number): boolean {
      const recent = (hits.get(key) ?? []).filter((t) => now - t < options.windowMs);
      if (recent.length >= options.limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.delete(key);
      hits.set(key, recent);
      if (hits.size > maxKeys) hits.delete(hits.keys().next().value!);
      return true;
    },
  };
}

const state = globalThis as typeof globalThis & { __slotkeeperHoldLimiter?: ReturnType<typeof createRateLimiter> };

/** hold_slot: at most 5 reservations per client every 10 minutes. */
export function getHoldLimiter() {
  state.__slotkeeperHoldLimiter ??= createRateLimiter({ limit: 5, windowMs: 10 * 60 * 1000 });
  return state.__slotkeeperHoldLimiter;
}
