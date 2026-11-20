// Circuit breaker (spec 6.7). Pure, with the clock passed into each call. Counts consecutive execution and
// verification failures; at `failureThreshold` it opens for `cooldownSec`; half-open, it lets 1 trial through; success
// closes it and failure reopens it. A trial that ends with no outcome must be released, or the breaker would stay
// half-open and blocked until the process restarts. In-memory state, global per process (a restart resets it).

export type BreakerState = "closed" | "open" | "half_open";

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private consecutiveFailures = 0;
  private openedAtMs: number | null = null;
  private trialTaken = false;

  constructor(o: { failureThreshold: number; cooldownSec: number }) {
    if (o.failureThreshold < 1 || o.cooldownSec < 0) throw new RangeError("circuit breaker with invalid parameters");
    this.failureThreshold = o.failureThreshold;
    this.cooldownMs = o.cooldownSec * 1000;
  }

  state(now: Date): BreakerState {
    if (this.openedAtMs === null) return "closed";
    return now.getTime() - this.openedAtMs < this.cooldownMs ? "open" : "half_open";
  }

  /** Fechado deixa passar; aberto barra; meia-aberto deixa passar só a primeira tentativa. */
  canExecute(now: Date): boolean {
    const s = this.state(now);
    if (s === "closed") return true;
    if (s === "open" || this.trialTaken) return false;
    this.trialTaken = true;
    return true;
  }

  /**
   * Gives back a half-open trial that ended without an outcome (throttled, or a batch the verifier will not judge),
   * so the next attempt can be the trial. No effect when no trial is in flight.
   */
  releaseTrial(): void {
    this.trialTaken = false;
  }

  recordSuccess(_now: Date): void {
    this.consecutiveFailures = 0;
    this.openedAtMs = null;
    this.trialTaken = false;
  }

  /** Devolve true quando esta falha abriu (ou reabriu) o breaker. */
  recordFailure(now: Date): boolean {
    const s = this.state(now);
    if (s === "open") return false;
    if (s === "half_open") {
      this.openedAtMs = now.getTime();
      this.trialTaken = false;
      return true;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < this.failureThreshold) return false;
    this.openedAtMs = now.getTime();
    this.trialTaken = false;
    return true;
  }
}
