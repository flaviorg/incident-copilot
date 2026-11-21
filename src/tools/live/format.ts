// Deterministic observation text for live telemetry (spec 008, decision 2). Pure: the same records give the same text
// whatever the vendor. Every string from a provider is sanitized here (control characters, delimiters, length), since
// it reaches the model inside an untrusted observation (AC-50).
import type { DeployRecord, ErrorGroup, LogEntry, MetricSeries } from "../../contracts/index.ts";
import { sanitizeText } from "../../domain/ingest/sanitize.ts";
import { formatMinutes, formatNumber, formatTs } from "../format.ts";

/** Sections of different connectors are joined with this separator. */
export const SECTION_SEPARATOR = " | ";

const clean = (s: string | null | undefined, max: number): string => (s ? sanitizeText(s, max) : "");
const count = (n: number) => formatNumber(n, 0);
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

/** en-US, no grouping, at most 4 decimals ("0.0961", "1240", "212.5"). */
export function formatValue(v: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4, useGrouping: false }).format(v);
}

export function formatErrorGroups(connectorId: string, service: string, window: string, groups: readonly ErrorGroup[]): string {
  if (groups.length === 0) return `${connectorId}: no error groups for ${service} over ${window}`;
  const parts = groups.map((g) => {
    const facts = [
      g.count !== null ? `${count(g.count)}x` : null,
      g.userCount !== null ? `${count(g.userCount)} users` : null,
      g.level ? clean(g.level, 40) : null,
      g.firstSeen ? `since ${formatTs(g.firstSeen, true)}` : null,
      g.release ? `release ${clean(g.release, 60)}` : null,
      g.status ? clean(g.status, 40) : null,
    ].filter((x) => x !== null && x !== "");
    const culprit = g.culprit ? ` (${clean(g.culprit, 80)})` : "";
    return `[${facts.join(", ")}] ${clean(g.title, 160)}${culprit}`;
  });
  return `${connectorId}: ${plural(groups.length, "error group", "error groups")} for ${service} over ${window}: ${parts.join("; ")}`;
}

export function formatMetricSeries(connectorId: string, service: string, window: string, s: MetricSeries | null, long: boolean): string {
  const metric = clean(s?.metric, 64);
  if (s === null || s.points.length === 0) return `${connectorId}: no samples for ${service} in the ${window} window`;
  const unit = s.unit ? ` ${clean(s.unit, 32)}` : "";
  const v = (x: number) => `${formatValue(x)}${unit}`;
  const first = s.points[0]!;
  const last = s.points.at(-1)!;
  const peak = s.points.reduce((a, p) => (p.value > a.value ? p : a), first);
  const mean = s.points.reduce((a, p) => a + p.value, 0) / s.points.length;
  return (
    `${connectorId}: ${metric} of ${service} over ${window} (${plural(s.points.length, "sample", "samples")}): ` +
    `start ${v(first.value)}, peak ${v(peak.value)} at ${formatTs(peak.ts, long)}, last ${v(last.value)}, mean ${v(mean)}`
  );
}

export function formatLogEntries(connectorId: string, service: string, level: string, window: string, entries: readonly LogEntry[], long: boolean): string {
  if (entries.length === 0) return `${connectorId}: no ${level} lines for ${service} in the ${window} window`;
  const total = entries.reduce((a, e) => a + e.count, 0);
  const parts = entries.map((e) => `[${count(e.count)}x, since ${formatTs(e.ts, long)}] ${clean(e.message, 160)}`);
  return `${connectorId}: ${count(total)} ${level} lines for ${service} over ${window}; most frequent: ${parts.join("; ")}`;
}

export function formatDeployRecords(connectorId: string, service: string, sinceMinutes: number, deploys: readonly DeployRecord[], now: Date): string {
  if (deploys.length === 0) return `${connectorId}: no deploy of ${service} in the last ${formatMinutes(sinceMinutes)}`;
  const parts = deploys.map((d) => {
    const ago = Math.round((now.getTime() - Date.parse(d.at)) / 60000);
    const extra = [d.environment ? clean(d.environment, 40) : null, d.author ? `by ${clean(d.author, 60)}` : null].filter((x) => x);
    return `${clean(d.version, 60)} at ${formatTs(d.at, true)} UTC, ${count(ago)} min ago${extra.length > 0 ? ` (${extra.join(", ")})` : ""}`;
  });
  return `${connectorId}: ${plural(deploys.length, "deploy", "deploys")} of ${service} in the last ${formatMinutes(sinceMinutes)}, most recent first: ${parts.join("; ")}`;
}

export function formatExternalResult(connectorId: string, tool: string, ok: boolean, text: string): string {
  return `${connectorId}/${clean(tool, 128)}: ${ok ? "" : "the tool reported an error: "}${clean(text, 500)}`;
}
