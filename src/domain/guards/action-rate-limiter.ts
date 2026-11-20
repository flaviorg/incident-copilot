// Execution limit (spec 6.7): 1-minute sliding window in total and at most 1 execution of the same action on the same
// target every `repeatWindowMin` (against repair loops). Pure, injected clock. A denied attempt does not count.

export class ActionRateLimiter {
  private readonly perMinute: number;
  private readonly repeatWindowMs: number;
  private recent: number[] = [];
  private readonly lastByKey = new Map<string, number>();

  constructor(o: { perMinute: number; repeatWindowMin: number }) {
    if (o.perMinute < 1 || o.repeatWindowMin < 0) throw new RangeError("rate limiter with invalid parameters");
    this.perMinute = o.perMinute;
    this.repeatWindowMs = o.repeatWindowMin * 60_000;
  }

  tryAcquire(actionType: string, target: string, now: Date): { ok: true } | { ok: false; reason: "global" | "repeat" } {
    const t = now.getTime();
    this.recent = this.recent.filter((x) => t - x < 60_000);
    if (this.recent.length >= this.perMinute) return { ok: false, reason: "global" };
    const key = `${actionType}@${target}`;
    const last = this.lastByKey.get(key);
    if (last !== undefined && t - last < this.repeatWindowMs) return { ok: false, reason: "repeat" };
    this.recent.push(t);
    this.lastByKey.set(key, t);
    return { ok: true };
  }
}
