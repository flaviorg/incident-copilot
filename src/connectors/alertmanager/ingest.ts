// Alertmanager webhook_config payload (version 4) to NormalizedAlerts. Pure and defensive: a payload of unexpected shape
// is invalid or ignored, never an exception. Every text goes through sanitizeText.
import { NormalizedAlertSchema } from "../../contracts/index.ts";
import type { NormalizedAlert, Severity } from "../../contracts/index.ts";
import { sanitizeAttributes, sanitizeText } from "../../domain/ingest/sanitize.ts";
import { mapSeverity } from "../../domain/ingest/severity.ts";
import { asRecord, asString, httpUrlOrNull, stableHash, toIsoOrNull } from "../shared/parse-utils.ts";
import type { InboundRequest, ParseOutcome } from "../types.ts";
import { DEFAULT_ALERTMANAGER_SEVERITY } from "./config.ts";
import type { AlertmanagerConfig } from "./config.ts";

export const ALERTMANAGER_SOURCE = "alertmanager";
const MAX_LABEL_ATTRIBUTES = 15;

/** Only string-valued labels (Prometheus labels are strings), sorted by name. */
function stringLabels(v: unknown): Record<string, string> {
  const r = asRecord(v);
  if (!r) return {};
  const entries = Object.entries(r).filter((e): e is [string, string] => typeof e[1] === "string").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries);
}

export function parseAlertmanagerPayload(
  body: unknown,
  req: InboundRequest,
  config: AlertmanagerConfig & { severityMap: Readonly<Record<string, Severity>> | null },
): ParseOutcome {
  try {
    const root = asRecord(body);
    if (!root || !Array.isArray(root.alerts)) return { kind: "invalid", issues: ["body must be an object with an alerts array"] };
    if (root.alerts.length === 0) return { kind: "ignored", reason: "no alerts in the payload" };
    const receiver = asString(root.receiver, 200);
    const groupKey = asString(root.groupKey, 200);
    const truncated = typeof root.truncatedAlerts === "number" && Number.isInteger(root.truncatedAlerts) && root.truncatedAlerts > 0 ? root.truncatedAlerts : 0;
    const severityMap = config.severityMap ?? DEFAULT_ALERTMANAGER_SEVERITY;

    const alerts: NormalizedAlert[] = [];
    for (const raw of root.alerts.slice(0, 1000)) {
      const a = asRecord(raw);
      if (!a) continue;
      const status = a.status === "firing" || a.status === "resolved" ? a.status : null;
      if (status === null) continue;
      const labels = stringLabels(a.labels);
      const annotations = stringLabels(a.annotations);
      const fingerprint = asString(a.fingerprint, 120) ?? stableHash(labels);
      const startedIso = toIsoOrNull(a.startsAt);
      // A resolved alert carries its resolution time in endsAt; that is the provider's time of this event.
      const eventIso = status === "resolved" ? (toIsoOrNull(a.endsAt) ?? startedIso) : startedIso;
      const startKey = startedIso ?? asString(a.startsAt, 60) ?? "unknown";
      const serviceRaw = [config.serviceLabel, ...config.fallbackServiceLabels].map((l) => labels[l]).find((v) => typeof v === "string" && v.trim() !== "");
      const title = asString(annotations[config.titleAnnotation], 200) ?? asString(labels.alertname, 200) ?? "Alertmanager alert";
      const labelAttrs = Object.entries(labels).slice(0, MAX_LABEL_ATTRIBUTES).map(([k, v]) => [`label.${k}`, v] as const);
      const attributes = sanitizeAttributes({
        ...(labels.alertname ? { alertname: labels.alertname } : {}),
        ...(receiver ? { receiver } : {}),
        ...(groupKey ? { groupKey } : {}),
        ...(truncated > 0 ? { truncatedAlerts: truncated } : {}),
        ...Object.fromEntries(labelAttrs),
      });
      const candidate = {
        source: ALERTMANAGER_SOURCE,
        externalId: sanitizeText(`${fingerprint}:${startKey}:${status}`, 200),
        fingerprint,
        service: serviceRaw ? sanitizeText(serviceRaw, 120) : null,
        title,
        severity: mapSeverity(labels[config.severityLabel], severityMap, "sev3"),
        status,
        startedAt: eventIso ?? req.receivedAt.toISOString(),
        url: httpUrlOrNull(a.generatorURL),
        signal: "other" as const,
        attributes,
      };
      const parsed = NormalizedAlertSchema.safeParse(candidate);
      if (parsed.success) alerts.push(parsed.data);
    }
    if (alerts.length === 0) return { kind: "ignored", reason: "no firing or resolved alert in the payload" };
    return { kind: "alerts", alerts };
  } catch {
    return { kind: "invalid", issues: ["payload could not be read"] };
  }
}
