// Lockout on wrong token attempts (spec 6.2 and 6.10): `maxFailures` within `windowMin` lock for `lockMin`.
// Pure, injected clock; sliding window over the failure instants.

export class TokenAttemptLimiter {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly lockMs: number;
  private failures: number[] = [];
  private lockedUntilMs: number | null = null;

  constructor(o: { maxFailures?: number; windowMin?: number; lockMin?: number } = {}) {
    this.maxFailures = o.maxFailures ?? 5;
    this.windowMs = (o.windowMin ?? 10) * 60_000;
    this.lockMs = (o.lockMin ?? 10) * 60_000;
  }

  isLocked(now: Date): boolean {
    return this.lockedUntilMs !== null && now.getTime() < this.lockedUntilMs;
  }

  recordFailure(now: Date): void {
    const t = now.getTime();
    this.failures = this.failures.filter((x) => t - x < this.windowMs);
    this.failures.push(t);
    if (this.failures.length >= this.maxFailures) {
      this.lockedUntilMs = t + this.lockMs;
      this.failures = [];
    }
  }
}
