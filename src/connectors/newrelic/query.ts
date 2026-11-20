// New Relic query capability: NRQL over NerdGraph (POST /graphql, `API-Key` header with a user key). The NRQL text is
// rendered from operator templates by renderNrql; the model only names a service and a metric. Rows are mapped
// defensively (their exact shapes are partly unverified, see docs/connectors/newrelic.md) and every record is
// validated against the live-telemetry contracts before it leaves.
import { DeployRecordSchema, ErrorGroupSchema, LogEntrySchema, MetricSeriesSchema } from "../../contracts/index.ts";
import type { DeployRecord, ErrorGroup, LogEntry, MetricSeries } from "../../contracts/index.ts";
import { ConnectorError } from "../shared/errors.ts";
import type { HttpClient } from "../shared/http.ts";
import { asRecord, asString, getPath, stableHash, toIsoOrNull } from "../shared/parse-utils.ts";
import type { QueryCapability, QueryIO } from "../types.ts";
import { resolveTemplates } from "./config.ts";
import type { NewRelicQueryConfig } from "./config.ts";
import { renderNrql } from "./nrql.ts";

export const NERDGRAPH_URL = { us: "https://api.newrelic.com/graphql", eu: "https://api.eu.newrelic.com/graphql" } as const;
// The scalar type name of $nrql is taken from the NerdGraph NRQL tutorial (Nrql!); unverified, see the docs.
export const NERDGRAPH_QUERY = "query($accountId: Int!, $nrql: Nrql!) { actor { account(id: $accountId) { nrql(query: $nrql) { results } } } }";

const MAX_POINTS = 500;
const MAX_ROWS = 5000;
const MAX_LEAF_DEPTH = 4;
const TIME_KEYS: ReadonlySet<string> = new Set(["beginTimeSeconds", "endTimeSeconds"]);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 1000;

const bad = () => new ConnectorError("bad_response");
const clampLimit = (n: number) => (Number.isSafeInteger(n) ? Math.min(MAX_LIMIT, Math.max(1, n)) : DEFAULT_LIMIT);

/** The first numeric value in a TIMESERIES row that is not a time key, searching nested objects and arrays. */
function firstNumericLeaf(v: unknown, depth = 0): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (depth >= MAX_LEAF_DEPTH) return null;
  const entries = Array.isArray(v) ? v.slice(0, 20).map((x) => [null, x] as const) : Object.entries(asRecord(v) ?? {});
  for (const [k, x] of entries) {
    if (k !== null && TIME_KEYS.has(k)) continue;
    const n = firstNumericLeaf(x, depth + 1);
    if (n !== null) return n;
  }
  return null;
}

function mapMetric(metric: string, rows: unknown[]): MetricSeries {
  const points: { ts: string; value: number }[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!row) continue;
    const begin = row.beginTimeSeconds;
    if (typeof begin !== "number" || !Number.isFinite(begin) || begin <= 0) continue;
    const d = new Date(begin * 1000);
    if (Number.isNaN(d.getTime())) continue;
    const value = firstNumericLeaf(row);
    if (value === null) continue;
    points.push({ ts: d.toISOString(), value });
  }
  points.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return MetricSeriesSchema.parse({ metric, unit: null, points: points.slice(-MAX_POINTS) });
}

/** FACET rows: `facet` as an array or a string, else the error.class and error.message keys. */
function facetParts(row: Record<string, unknown>): string[] {
  const f = row.facet;
  const fromFacet = (Array.isArray(f) ? f.slice(0, 5) : [f])
    .map((x) => (typeof x === "string" || typeof x === "number" ? asString(x, 200) : null))
    .filter((x): x is string => x !== null);
  if (fromFacet.length > 0) return fromFacet;
  return [row["error.class"], row["error.message"]].map((x) => asString(x, 200)).filter((x): x is string => x !== null);
}

function mapErrors(rows: unknown[], limit: number): ErrorGroup[] {
  const out: ErrorGroup[] = [];
  for (const raw of rows) {
    if (out.length >= limit) break;
    const row = asRecord(raw);
    if (!row) continue;
    const parts = facetParts(row);
    const title = asString(parts.join(": "), 300);
    if (title === null) continue;
    const c = row.count;
    const count = typeof c === "number" && Number.isFinite(c) && c >= 0 ? Math.round(c) : null;
    out.push(ErrorGroupSchema.parse({
      id: stableHash(parts), title, culprit: null, level: null, status: null, count, userCount: null,
      firstSeen: null, lastSeen: null, release: null, url: null,
    }));
  }
  return out;
}

function levelOf(v: unknown, fallback: "ERROR" | "WARN"): "ERROR" | "WARN" | "INFO" {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  if (["ERROR", "ERR", "FATAL", "CRITICAL", "SEVERE", "PANIC"].includes(s)) return "ERROR";
  if (["WARN", "WARNING"].includes(s)) return "WARN";
  if (["INFO", "INFORMATION", "NOTICE"].includes(s)) return "INFO";
  return fallback;
}

function mapLogs(rows: unknown[], requested: "ERROR" | "WARN", limit: number): LogEntry[] {
  const out: LogEntry[] = [];
  for (const raw of rows) {
    if (out.length >= limit) break;
    const row = asRecord(raw);
    if (!row) continue;
    const ts = toIsoOrNull(row.timestamp);
    const message = asString(row.message, 500);
    if (ts === null || message === null) continue;
    out.push(LogEntrySchema.parse({ ts, level: levelOf(row.level, requested), message, count: 1 }));
  }
  return out;
}

function mapDeploys(rows: unknown[], since: Date): DeployRecord[] {
  const out: DeployRecord[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!row) continue;
    const at = toIsoOrNull(row.timestamp);
    if (at === null || Date.parse(at) < since.getTime()) continue;
    out.push(DeployRecordSchema.parse({
      version: asString(row.version, 120) ?? "unknown", at, environment: null,
      author: asString(row.user, 120), description: asString(row.description, 300), url: null,
    }));
  }
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return out.slice(0, 50);
}

export function createNewRelicQuery(config: NewRelicQueryConfig, http: HttpClient): QueryCapability {
  const url = NERDGRAPH_URL[config.region];
  const templates = resolveTemplates(config.nrql);

  /** Runs one rendered NRQL query; returns the rows of data.actor.account.nrql.results. */
  async function run(nrql: string, io: QueryIO): Promise<unknown[]> {
    const body = await http.json<unknown>({
      method: "POST",
      url,
      headers: { "API-Key": config.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query: NERDGRAPH_QUERY, variables: { accountId: config.accountId, nrql } }),
      signal: io.signal,
    });
    const root = asRecord(body);
    if (!root) throw bad();
    if (root.errors !== undefined && root.errors !== null && !(Array.isArray(root.errors) && root.errors.length === 0)) throw bad();
    const results = getPath(root, "data.actor.account.nrql.results");
    if (!Array.isArray(results)) throw bad();
    return results.slice(0, MAX_ROWS);
  }

  const { errors, logs, deploys } = templates;
  return {
    metricNames: Object.keys(templates.metrics),
    async metrics(q, io) {
      if (!Object.hasOwn(templates.metrics, q.metric)) return null;
      const nrql = renderNrql(templates.metrics[q.metric]!, { service: q.service, since: q.window.from.getTime(), until: q.window.to.getTime() });
      return mapMetric(q.metric, await run(nrql, io));
    },
    ...(errors !== null
      ? {
        async errors(q, io) {
          const limit = clampLimit(q.limit);
          const nrql = renderNrql(errors, { service: q.service, since: q.window.from.getTime(), until: q.window.to.getTime(), limit });
          return mapErrors(await run(nrql, io), limit);
        },
      }
      : {}),
    ...(logs !== null
      ? {
        async logs(q, io) {
          const limit = clampLimit(q.limit);
          const nrql = renderNrql(logs, { service: q.service, level: q.level, since: q.window.from.getTime(), until: q.window.to.getTime(), limit });
          return mapLogs(await run(nrql, io), q.level, limit);
        },
      }
      : {}),
    ...(deploys !== null
      ? {
        async deploys(q, io) {
          const nrql = renderNrql(deploys, { service: q.service, since: q.since.getTime(), until: io.now.getTime(), limit: 10 });
          return mapDeploys(await run(nrql, io), q.since);
        },
      }
      : {}),
  };
}
