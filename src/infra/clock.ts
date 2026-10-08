// Relógio injetado (spec 4.3 e 7.5). SimulatedClock deixa demo e testes reprodutíveis byte a byte.

export interface Clock {
  now(): Date;
  /** Durações simuladas (LLM, ferramenta, dry run, execução); no-op no SystemClock. */
  tick(seconds: number): void;
  /** SimulatedClock vai para o detectedAt do cenário e o devolve; SystemClock devolve agora. */
  alignTo(scenarioDetectedAt: Date): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  tick(_seconds: number): void {}
  alignTo(_scenarioDetectedAt: Date): Date {
    return new Date();
  }
}

export class SimulatedClock implements Clock {
  private currentMs: number;
  constructor(start: Date) {
    this.currentMs = start.getTime();
  }
  now(): Date {
    return new Date(this.currentMs);
  }
  tick(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError(`invalid tick: ${seconds}`);
    this.currentMs += Math.round(seconds * 1000);
  }
  alignTo(scenarioDetectedAt: Date): Date {
    this.currentMs = scenarioDetectedAt.getTime();
    return new Date(this.currentMs);
  }
}
