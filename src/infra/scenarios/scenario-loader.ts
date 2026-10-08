// Carrega e valida cenários de fixtures/scenarios/<id>/ e materializa as séries (spec 4.2 e 7.3). Não chama LLM.
// Erro de dado no disco vira ValidationError com o nome do arquivo e o campo, sem derrubar o processo com stack.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type * as z from "zod";
import {
  AfterFileSchema, DeploysFileSchema, InventorySchema, LogLineSchema, ScenarioFileSchema, SignalsFileSchema,
} from "../../contracts/index.ts";
import type {
  AfterFile, Alert, Deploy, Inventory, LogLine, MetricName, ScenarioFile, ScenarioSummary, SeriesPoint, SignalsFile,
} from "../../contracts/index.ts";
import { NotFoundError, ValidationError } from "../../domain/errors.ts";
import { formatIssues, parseWithIssues } from "../../domain/validation.ts";
import { clampFor, materializeSeries } from "../../domain/telemetry/series.ts";

export type LoadedScenario = {
  id: string;
  summary: ScenarioSummary;
  file: ScenarioFile;
  alert: Alert;
  series: Partial<Record<MetricName, SeriesPoint[]>>;
  logs: LogLine[];
  deploys: Deploy[];
  inventory: Inventory | null;
  after: AfterFile | null;
  offsetSec: number;
};

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** Mesmo teto do CreateIncidentBodySchema: id fora do formato nunca volta na mensagem de erro. */
const SCENARIO_ID_MAX = 64;

const shiftIso = (iso: string, offsetSec: number) => (offsetSec === 0 ? iso : new Date(Date.parse(iso) + offsetSec * 1000).toISOString());

function toSummary(f: ScenarioFile): ScenarioSummary {
  return { id: f.id, title: f.title, summary: f.summary, service: f.service, account: f.account, severity: f.severity };
}

export class ScenarioRepository {
  private readonly rootDir: string;
  private readonly transform: ((s: LoadedScenario) => LoadedScenario) | undefined;
  private readonly cache = new Map<string, LoadedScenario>();

  constructor(o: { rootDir: string; transform?: (s: LoadedScenario) => LoadedScenario }) {
    this.rootDir = o.rootDir;
    this.transform = o.transform;
  }

  /** Resumos ordenados por id. */
  list(): ScenarioSummary[] {
    if (!existsSync(this.rootDir)) return [];
    return readdirSync(this.rootDir)
      .filter((name) => ID_PATTERN.test(name) && existsSync(join(this.rootDir, name, "scenario.json")))
      .sort()
      .map((id) => toSummary(this.readScenarioFile(id)));
  }

  get(id: string, o: { offsetSec?: number } = {}): LoadedScenario {
    const offsetSec = o.offsetSec ?? 0;
    const key = `${id}@${offsetSec}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    let loaded = this.load(id, offsetSec);
    if (this.transform) loaded = this.transform(loaded);
    this.cache.set(key, loaded);
    return loaded;
  }

  private dirOf(id: string): string {
    const dir = join(this.rootDir, id);
    if (!ID_PATTERN.test(id) || id.length > SCENARIO_ID_MAX) {
      throw new NotFoundError("scenario_not_found", "scenario not found (id out of format)");
    }
    if (!existsSync(join(dir, "scenario.json")) || !statSync(dir).isDirectory()) {
      throw new NotFoundError("scenario_not_found", `scenario not found: ${id}`);
    }
    return dir;
  }

  private readJson<T>(id: string, file: string, schema: z.ZodType<T>): T {
    const path = join(this.dirOf(id), file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new ValidationError(`scenario ${id}: ${file} is not valid JSON (${(e as Error).message})`, [{ path: file, message: "invalid JSON" }]);
    }
    const r = parseWithIssues(schema, raw);
    if (!r.success) {
      throw new ValidationError(
        `scenario ${id}: ${file} invalid at ${formatIssues(r.issues)}`,
        r.issues.map((i) => ({ path: `${file}:${i.path}`, message: i.message })),
      );
    }
    return r.data;
  }

  private readOptionalJson<T>(id: string, file: string, schema: z.ZodType<T>): T | null {
    return existsSync(join(this.dirOf(id), file)) ? this.readJson(id, file, schema) : null;
  }

  private readScenarioFile(id: string): ScenarioFile {
    const f = this.readJson(id, "scenario.json", ScenarioFileSchema);
    if (f.id !== id) {
      throw new ValidationError(`scenario ${id}: scenario.json invalid at id (differs from the folder name: ${f.id})`, [
        { path: "scenario.json:id", message: "differs from the folder name" },
      ]);
    }
    return f;
  }

  private readLogs(id: string): LogLine[] {
    const path = join(this.dirOf(id), "logs.jsonl");
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf8").split("\n");
    const out: LogLine[] = [];
    lines.forEach((line, idx) => {
      if (line.trim() === "") return;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new ValidationError(`scenario ${id}: logs.jsonl line ${idx + 1} is not valid JSON`, [{ path: `logs.jsonl:${idx + 1}`, message: "invalid JSON" }]);
      }
      const r = parseWithIssues(LogLineSchema, raw);
      if (!r.success) {
        throw new ValidationError(
          `scenario ${id}: logs.jsonl line ${idx + 1} invalid at ${formatIssues(r.issues)}`,
          r.issues.map((i) => ({ path: `logs.jsonl:${idx + 1}:${i.path}`, message: i.message })),
        );
      }
      out.push(r.data);
    });
    return out;
  }

  private load(id: string, offsetSec: number): LoadedScenario {
    const file = this.readScenarioFile(id);
    const signals: SignalsFile = this.readJson(id, "signals.json", SignalsFileSchema);
    const logs = this.readLogs(id);
    const deploys = this.readOptionalJson(id, "deploys.json", DeploysFileSchema) ?? [];
    const inventory = this.readOptionalJson(id, "inventory.json", InventorySchema);
    const after = this.readOptionalJson(id, "after.json", AfterFileSchema);

    const start = new Date(Date.parse(signals.start) + offsetSec * 1000);
    const series: Partial<Record<MetricName, SeriesPoint[]>> = {};
    for (const [metric, spec] of Object.entries(signals.series) as [MetricName, NonNullable<SignalsFile["series"][MetricName]>][]) {
      series[metric] = materializeSeries(spec, start, signals.resolutionSec, signals.durationSec, { clamp: clampFor(metric) });
    }

    const shiftedFile: ScenarioFile = { ...file, alert: { ...file.alert, detectedAt: shiftIso(file.alert.detectedAt, offsetSec) } };
    const alert: Alert = {
      title: file.title,
      service: file.service,
      account: file.account,
      signal: file.alert.signal,
      threshold: file.alert.threshold,
      rule: file.alert.rule,
      detectedAt: shiftedFile.alert.detectedAt,
      severity: file.severity,
    };

    return {
      id,
      summary: toSummary(file),
      file: shiftedFile,
      alert,
      series,
      logs: logs.map((l) => ({ ...l, ts: shiftIso(l.ts, offsetSec) })),
      deploys: deploys.map((d) => ({ ...d, at: shiftIso(d.at, offsetSec) })),
      inventory,
      after,
      offsetSec,
    };
  }
}
