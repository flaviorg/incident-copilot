// Circuit breaker (spec 6.7). Puro, relógio injetado em cada chamada. Conta falhas consecutivas de execução e de
// verificação; com `failureThreshold`, abre por `cooldownSec`; em meia-abertura deixa passar 1 tentativa; sucesso
// fecha e falha reabre. Estado em memória, global por processo (reiniciar zera; limitação documentada).

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
