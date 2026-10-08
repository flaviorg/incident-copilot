// Um só gerador de ids em todos os modos (spec 4.3 e 7.5): contadores na tabela `sequences`.
// Num banco novo tudo é determinístico; num banco persistido os ids continuam a sequência.
import type { SqliteIncidentStore } from "./db/incident-store.ts";

export interface Ids {
  incident(): string;
  approval(): string;
  action(): string;
  run(): string;
  event(incidentId: string, seq: number): string;
}

export const padId = (prefix: string, n: number) => `${prefix}-${String(n).padStart(4, "0")}`;

export class DbIds implements Ids {
  private readonly store: Pick<SqliteIncidentStore, "nextSequence">;
  constructor(store: Pick<SqliteIncidentStore, "nextSequence">) {
    this.store = store;
  }
  incident(): string { return padId("INC", this.store.nextSequence("incident")); }
  approval(): string { return padId("APR", this.store.nextSequence("approval")); }
  action(): string { return padId("ACT", this.store.nextSequence("action")); }
  run(): string { return padId("RUN", this.store.nextSequence("run")); }
  event(incidentId: string, seq: number): string { return `${incidentId}:${seq}`; }
}
