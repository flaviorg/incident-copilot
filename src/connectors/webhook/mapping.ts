// Field mapping of the generic webhook connector: a body (already authenticated) to NormalizedAlerts, driven by the
// paths of the config. Pure and defensive: unexpected shapes are skipped, invalid or ignored, never an exception.
// Issues name the mapping key and never a value from the payload. Every text goes through sanitizeText.
import { NormalizedAlertSchema } from "../../contracts/index.ts";
import type { NormalizedAlert, Severity } from "../../contracts/index.ts";
import { sanitizeAttributes, sanitizeText } from "../../domain/ingest/sanitize.ts";
import { mapSeverity } from "../../domain/ingest/severity.ts";
import { getPath, httpUrlOrNull, toIsoOrNull } from "../shared/parse-utils.ts";
import type { InboundRequest, ParseOutcome } from "../types.ts";
import { DEFAULT_MAX_ALERTS_PER_REQUEST } from "./config.ts";
import type { WebhookMapping } from "./config.ts";

export const WEBHOOK_SOURCE = "webhook";

export type MappingOptions = {
  /** Elements beyond this are dropped and counted in the "truncated" attribute of the first alert. */
  maxAlertsPerRequest?: number;
  /** The entry's severityMap: consulted after mapping.severity.map. */
  severityMap?: Readonly<Record<string, Severity>> | null;
};

const PLACEHOLDER = /\{([^{}]*)\}/g;

/** A sanitized string for a string, finite number or boolean; null for anything else or an empty text. */
function scalar(v: unknown, max: number): string | null {
  const raw = typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "boolean" ? String(v) : null;
  if (raw === null) return null;
  const s = sanitizeText(raw, max);
  return s === "" ? null : s;
}

function renderTitle(title: WebhookMapping["title"], element: unknown): string | null {
  if (typeof title === "string") return scalar(getPath(element, title), 200);
  let resolved = 0;
  const text = title.template.replace(PLACEHOLDER, (_whole, path: string) => {
    const v = scalar(getPath(element, path), 200);
    if (v === null) return "";
    resolved += 1;
    return v;
  });
  return resolved === 0 ? null : scalar(text, 200);
}

type Skip = "externalId" | "title" | "alert";

function mapElement(mapping: WebhookMapping, element: unknown, req: InboundRequest, options: MappingOptions): NormalizedAlert | Skip {
  const externalId = scalar(getPath(element, mapping.externalId), 200);
  if (externalId === null) return "externalId";
  const title = renderTitle(mapping.title, element);
  if (title === null) return "title";

  const fingerprint = (mapping.fingerprint ? scalar(getPath(element, mapping.fingerprint), 200) : null) ?? externalId;
  const service = mapping.service ? scalar(getPath(element, mapping.service), 120) : null;

  let severity: Severity = "sev3";
  if (mapping.severity) {
    const raw = scalar(getPath(element, mapping.severity.path), 100);
    // The configured map wins; the entry's severityMap only covers a value the map does not list.
    const map = raw !== null && !hasKey(mapping.severity.map, raw) && options.severityMap ? options.severityMap : mapping.severity.map;
    severity = mapSeverity(raw, map, mapping.severity.default);
  }

  let status: "firing" | "resolved" = "firing";
  if (mapping.status) {
    const raw = scalar(getPath(element, mapping.status.path), 100);
    if (raw !== null && mapping.status.resolvedValues.some((r) => r.trim().toLowerCase() === raw.toLowerCase())) status = "resolved";
  }

  const startedAt = (mapping.startedAt ? toIsoOrNull(getPath(element, mapping.startedAt)) : null) ?? req.receivedAt.toISOString();
  const url = mapping.url ? httpUrlOrNull(getPath(element, mapping.url)) : null;

  const attributes: Record<string, string> = {};
  for (const [name, path] of Object.entries(mapping.attributes ?? {})) {
    const v = scalar(getPath(element, path), 500);
    if (v !== null) attributes[name] = v;
  }

  const parsed = NormalizedAlertSchema.safeParse({
    source: WEBHOOK_SOURCE, externalId, fingerprint, service, title, severity, status, startedAt, url, signal: mapping.signal, attributes,
  });
  return parsed.success ? parsed.data : "alert";
}

function hasKey(map: Readonly<Record<string, Severity>>, value: string): boolean {
  const wanted = value.trim().toLowerCase();
  return Object.keys(map).some((k) => k.trim().toLowerCase() === wanted);
}

export function applyMapping(mapping: WebhookMapping, body: unknown, req: InboundRequest, options: MappingOptions = {}): ParseOutcome {
  try {
    let elements: unknown[];
    if (mapping.alerts !== undefined) {
      const found = getPath(body, mapping.alerts);
      if (!Array.isArray(found)) return { kind: "invalid", issues: ["mapping.alerts: the value at this path is not an array"] };
      if (found.length === 0) return { kind: "ignored", reason: "no alerts in the payload" };
      elements = found;
    } else {
      elements = [body];
    }

    const max = options.maxAlertsPerRequest ?? DEFAULT_MAX_ALERTS_PER_REQUEST;
    const dropped = Math.max(0, elements.length - max);
    const alerts: NormalizedAlert[] = [];
    const skipped: Record<Skip, number> = { externalId: 0, title: 0, alert: 0 };
    for (const element of elements.slice(0, max)) {
      const out = mapElement(mapping, element, req, options);
      if (typeof out === "string") skipped[out] += 1;
      else alerts.push(out);
    }

    if (alerts.length === 0) {
      const issues: string[] = [];
      if (skipped.externalId > 0) issues.push("mapping.externalId: no usable value in the payload");
      if (skipped.title > 0) issues.push("mapping.title: no usable value in the payload");
      if (skipped.alert > 0) issues.push("mapping: the mapped fields do not form a valid alert");
      return { kind: "invalid", issues };
    }

    if (dropped > 0) {
      const first = alerts[0]!;
      // "truncated" goes first so the 20-attribute cap drops a configured attribute, not the marker.
      const { truncated: _replaced, ...rest } = first.attributes;
      first.attributes = sanitizeAttributes({ truncated: dropped, ...rest });
    }
    return { kind: "alerts", alerts };
  } catch {
    return { kind: "invalid", issues: ["payload could not be read"] };
  }
}
