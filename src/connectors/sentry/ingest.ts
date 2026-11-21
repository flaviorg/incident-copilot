// Sentry integration-platform webhooks to NormalizedAlerts (docs/connectors/sentry.md). Pure and defensive: the
// resource comes from the Sentry-Hook-Resource header, a payload of unexpected shape is invalid or ignored, never an
// exception. event_alert and issue share the fingerprint issue:<id>, so they dedupe into one incident.
import { NormalizedAlertSchema } from "../../contracts/index.ts";
import type { NormalizedAlert, Severity } from "../../contracts/index.ts";
import { sanitizeAttributes, sanitizeText } from "../../domain/ingest/sanitize.ts";
import { mapSeverity } from "../../domain/ingest/severity.ts";
import { verifyWebhookAuth } from "../shared/auth.ts";
import { asRecord, asString, httpUrlOrNull, toIsoOrNull } from "../shared/parse-utils.ts";
import type { InboundRequest, ParseOutcome, VerifyOutcome } from "../types.ts";
import { DEFAULT_SENTRY_LEVEL_SEVERITY, DEFAULT_SENTRY_METRIC_SEVERITY } from "./config.ts";
import type { SentryConfig } from "./config.ts";

export const SENTRY_SOURCE = "sentry";
export const SIGNATURE_HEADER = "sentry-hook-signature";
export const RESOURCE_HEADER = "sentry-hook-resource";

type IngestConfig = NonNullable<SentryConfig["ingest"]> & { severityMap: Readonly<Record<string, Severity>> | null };
type Parsed = { kind: "alert"; alert: unknown } | { kind: "ignored"; reason: string } | { kind: "invalid"; issue: string };

/**
 * HMAC-SHA256 hex digest of the raw body keyed with the Client Secret (AC-57). Only the body is signed: the timestamp
 * and resource headers are not part of the digest. Reuses the shared constant-time HMAC check, IP allowlist first.
 */
export function verifySentrySignature(config: Pick<IngestConfig, "clientSecret" | "allowedIps">, req: InboundRequest): VerifyOutcome {
  return verifyWebhookAuth(
    { type: "hmac", header: SIGNATURE_HEADER, secret: config.clientSecret, algorithm: "sha256", encoding: "hex", prefix: "", ...(config.allowedIps ? { allowedIps: config.allowedIps } : {}) },
    req,
  );
}

/** The configured map (case-insensitive) wins over the defaults; values it does not name keep the default. */
function severityOf(value: unknown, defaults: Readonly<Record<string, Severity>>, custom: IngestConfig["severityMap"], fallback: Severity): Severity {
  const merged: Record<string, Severity> = { ...defaults };
  for (const [k, v] of Object.entries(custom ?? {})) merged[k.trim().toLowerCase()] = v;
  return mapSeverity(typeof value === "string" ? value : null, merged, fallback);
}

const SEVERITY_ORDER: Severity[] = ["sev1", "sev2", "sev3"];
const atLeast = (s: Severity, floor: Severity): Severity => (SEVERITY_ORDER.indexOf(s) <= SEVERITY_ORDER.indexOf(floor) ? s : floor);

/** A project slug: a string, or an object carrying a string slug. A numeric id is not a slug. */
function projectSlug(v: unknown): string | null {
  if (typeof v === "string") return asString(v, 120);
  const r = asRecord(v);
  return r && typeof r.slug === "string" ? asString(r.slug, 120) : null;
}

function clip(s: string, max: number): string {
  return sanitizeText(s, max);
}

function parseEventAlert(body: Record<string, unknown>, req: InboundRequest, cfg: IngestConfig): Parsed {
  if (body.action !== "triggered") return { kind: "ignored", reason: "event_alert action is not triggered" };
  const data = asRecord(body.data);
  const event = asRecord(data?.event);
  if (!event) return { kind: "invalid", issue: "data.event is missing" };
  const issueId = asString(event.issue_id, 100);
  const eventId = asString(event.event_id, 100);
  if (!issueId) return { kind: "invalid", issue: "event.issue_id is missing" };
  const rule = asString(data?.triggered_rule, 100) ?? "unknown";
  const level = asString(event.level, 40);
  const platform = asString(event.platform, 60);
  return {
    kind: "alert",
    alert: {
      source: SENTRY_SOURCE,
      externalId: clip(`event_alert:${eventId ?? issueId}:${rule}`, 200),
      fingerprint: `issue:${issueId}`,
      service: projectSlug(event.project),
      title: asString(event.title, 200) ?? "Sentry error alert",
      severity: severityOf(level, DEFAULT_SENTRY_LEVEL_SEVERITY, cfg.severityMap, "sev2"),
      status: "firing",
      startedAt: toIsoOrNull(event.datetime) ?? toIsoOrNull(event.timestamp) ?? req.receivedAt.toISOString(),
      url: httpUrlOrNull(event.web_url),
      signal: "error_events",
      attributes: sanitizeAttributes({ triggered_rule: rule, ...(level ? { level } : {}), ...(platform ? { platform } : {}), issueId }),
    },
  };
}

function parseMetricAlert(body: Record<string, unknown>, req: InboundRequest, cfg: IngestConfig): Parsed {
  const action = body.action;
  if (action !== "critical" && action !== "warning" && action !== "resolved") return { kind: "ignored", reason: "metric_alert action is not critical, warning or resolved" };
  const data = asRecord(body.data);
  const metric = asRecord(data?.metric_alert);
  if (!metric) return { kind: "invalid", issue: "data.metric_alert is missing" };
  const id = asString(metric.id, 100);
  if (!id) return { kind: "invalid", issue: "metric_alert.id is missing" };
  const rule = asRecord(metric.alert_rule);
  const projects = Array.isArray(metric.projects) ? metric.projects : [];
  const detected = toIsoOrNull(metric.date_detected);
  const started = toIsoOrNull(metric.date_started);
  const closed = toIsoOrNull(metric.date_closed);
  const received = req.receivedAt.toISOString();
  const resolved = action === "resolved";
  const timeWindow = asString(rule?.time_window, 20);
  const eventKey = closed ?? detected ?? started ?? received;
  return {
    kind: "alert",
    alert: {
      source: SENTRY_SOURCE,
      externalId: clip(`metric_alert:${id}:${action}:${eventKey}`, 200),
      fingerprint: `metric_alert:${id}`,
      service: projects.map(projectSlug).find((s) => s !== null) ?? null,
      title: asString(data?.description_title, 200) ?? asString(metric.title, 200) ?? asString(rule?.name, 200) ?? "Sentry metric alert",
      severity: resolved ? "sev3" : severityOf(action, DEFAULT_SENTRY_METRIC_SEVERITY, cfg.severityMap, "sev2"),
      status: resolved ? "resolved" : "firing",
      // A resolved alert carries the provider's closing time; a firing one the time the threshold was crossed.
      startedAt: resolved ? (closed ?? detected ?? started ?? received) : (started ?? detected ?? received),
      url: httpUrlOrNull(data?.web_url),
      signal: "other",
      attributes: sanitizeAttributes({
        ...(asString(rule?.aggregate, 100) ? { aggregate: asString(rule?.aggregate, 100) } : {}),
        ...(asString(rule?.dataset, 60) ? { dataset: asString(rule?.dataset, 60) } : {}),
        ...(asString(rule?.query, 300) ? { query: asString(rule?.query, 300) } : {}),
        ...(asString(rule?.environment, 100) ? { environment: asString(rule?.environment, 100) } : {}),
        ...(timeWindow ? { timeWindow } : {}),
      }),
    },
  };
}

function parseIssue(body: Record<string, unknown>, req: InboundRequest, cfg: IngestConfig): Parsed {
  const action = body.action;
  if (action !== "created" && action !== "unresolved" && action !== "resolved") return { kind: "ignored", reason: "issue action does not change the alert state" };
  const issue = asRecord(asRecord(body.data)?.issue);
  if (!issue) return { kind: "invalid", issue: "data.issue is missing" };
  const id = asString(issue.id, 100);
  if (!id) return { kind: "invalid", issue: "issue.id is missing" };
  const resolved = action === "resolved";
  const received = req.receivedAt.toISOString();
  const lastSeen = toIsoOrNull(issue.lastSeen);
  const priority = asString(issue.priority, 20);
  let severity = severityOf(issue.level, DEFAULT_SENTRY_LEVEL_SEVERITY, cfg.severityMap, "sev3");
  if (priority?.toLowerCase() === "high") severity = atLeast(severity, "sev2");
  const attr = (v: unknown, max: number) => asString(v, max) ?? undefined;
  return {
    kind: "alert",
    alert: {
      source: SENTRY_SOURCE,
      externalId: clip(`issue:${id}:${action}:${lastSeen ?? received}`, 200),
      fingerprint: `issue:${id}`,
      service: projectSlug(issue.project),
      title: asString(issue.title, 200) ?? "Sentry issue",
      severity,
      status: resolved ? "resolved" : "firing",
      // Sentry sends no closing time for an issue: the receipt time stands in for a resolution.
      startedAt: resolved ? received : (toIsoOrNull(issue.firstSeen) ?? received),
      url: httpUrlOrNull(issue.web_url) ?? httpUrlOrNull(issue.permalink),
      signal: "error_events",
      attributes: sanitizeAttributes({
        shortId: attr(issue.shortId, 100), culprit: attr(issue.culprit, 300), status: attr(issue.status, 40), substatus: attr(issue.substatus, 40),
        priority: priority ?? undefined, count: attr(issue.count, 40), userCount: attr(issue.userCount, 40),
      }),
    },
  };
}

export function parseSentryPayload(body: unknown, req: InboundRequest, config: IngestConfig): ParseOutcome {
  try {
    const resource = (req.headers[RESOURCE_HEADER] ?? "").trim().toLowerCase();
    if (resource === "") return { kind: "invalid", issues: ["Sentry-Hook-Resource header is missing"] };
    const root = asRecord(body);
    if (!root) return { kind: "invalid", issues: ["body must be a JSON object"] };
    if (resource !== "event_alert" && resource !== "metric_alert" && resource !== "issue") return { kind: "ignored", reason: `resource ${clip(resource, 40)} is not an alert` };
    if (!config.resources.includes(resource)) return { kind: "ignored", reason: `resource ${resource} is not enabled for this connector` };
    const parsed = resource === "event_alert" ? parseEventAlert(root, req, config) : resource === "metric_alert" ? parseMetricAlert(root, req, config) : parseIssue(root, req, config);
    if (parsed.kind === "ignored") return parsed;
    if (parsed.kind === "invalid") return { kind: "invalid", issues: [parsed.issue] };
    const checked = NormalizedAlertSchema.safeParse(parsed.alert);
    if (!checked.success) return { kind: "invalid", issues: ["payload does not describe a usable alert"] };
    const alerts: NormalizedAlert[] = [checked.data];
    return { kind: "alerts", alerts };
  } catch {
    return { kind: "invalid", issues: ["payload could not be read"] };
  }
}
