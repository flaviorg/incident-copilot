// Injected clock (spec 4.3 and 7.5). SimulatedClock makes demo and tests reproducible byte for byte.

export interface Clock {
  now(): Date;
  /** Simulated durations (LLM, tool, dry run, execution); no-op on SystemClock. */
  tick(seconds: number): void;
  /** SimulatedClock goes to the scenario's detectedAt and returns it; SystemClock returns now. */
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
