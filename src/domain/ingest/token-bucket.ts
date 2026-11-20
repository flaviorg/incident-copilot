// Per-connector ingest rate limit (spec 008, decision 10): a token bucket on an injected clock. Pure.

export type TokenBucket = { take(): { ok: true } | { ok: false; retryAfterSec: number } };

/** Capacity `ratePerMin`, refilled continuously at `ratePerMin` per minute; starts full. `now` is in milliseconds. */
export function createTokenBucket(o: { ratePerMin: number; now: () => number }): TokenBucket {
  const capacity = o.ratePerMin;
  const perMs = o.ratePerMin / 60_000;
  let tokens = capacity;
  let last = o.now();
  return {
    take() {
      const t = o.now();
      tokens = Math.min(capacity, tokens + Math.max(0, t - last) * perMs);
      last = t;
      if (tokens >= 1) {
        tokens -= 1;
        return { ok: true };
      }
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - tokens) / perMs / 1000)) };
    },
  };
}
