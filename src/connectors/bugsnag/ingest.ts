// Bugsnag Data Forwarding webhook to NormalizedAlerts. Pure and defensive: a payload of unexpected shape is invalid or
// ignored, never an exception. Every text goes through sanitizeText (asString does).
import { NormalizedAlertSchema } from "../../contracts/index.ts";
import type { NormalizedAlert, Severity } from "../../contracts/index.ts";
import { sanitizeAttributes } from "../../domain/ingest/sanitize.ts";
import { mapSeverity } from "../../domain/ingest/severity.ts";
import { asRecord, asString, httpUrlOrNull, toIsoOrNull } from "../shared/parse-utils.ts";
import type { InboundRequest, ParseOutcome } from "../types.ts";
import { DEFAULT_BUGSNAG_SEVERITY } from "./config.ts";

export const BUGSNAG_SOURCE = "bugsnag";

/** Triggers that never make an alert, whatever the config says. Unknown types are ignored the same way. */
const NEVER_ALERTS = new Set(["comment", "release", "projectSamplingStarted", "projectApproachingRateLimit"]);
const ERROR_TRIGGERS_NEED_ERROR = new Set(["exception", "firstException", "errorEventFrequency", "powerTen", "reopened", "errorStateManualChange"]);

export type BugsnagIngestConfig = { triggers: readonly string[]; severityMap: Readonly<Record<string, Severity>> | null };

function firstException(error: Record<string, unknown>): Record<string, unknown> | null {
  return Array.isArray(error.exceptions) ? asRecord(error.exceptions[0]) : null;
}

function titleOf(error: Record<string, unknown> | null, trigger: Record<string, unknown>): string {
  if (error) {
    const first = firstException(error);
    const cls = asString(error.exceptionClass, 200) ?? asString(first?.errorClass, 200);
    const message = asString(error.message, 200) ?? asString(first?.message, 200);
    const joined = cls && message ? asString(`${cls}: ${message}`, 200) : (cls ?? message);
    if (joined) return joined;
  }
  return asString(trigger.message, 200) ?? "Bugsnag alert";
}

export function parseBugsnagPayload(body: unknown, req: InboundRequest, config: BugsnagIngestConfig): ParseOutcome {
  try {
    const root = asRecord(body);
    const trigger = asRecord(root?.trigger);
    const type = typeof trigger?.type === "string" ? trigger.type : null;
    if (!root || !trigger || type === null || type === "") return { kind: "invalid", issues: ["body must be an object with trigger.type"] };
    if (NEVER_ALERTS.has(type)) return { kind: "ignored", reason: "this Bugsnag trigger is not an alert" };
    if (!config.triggers.includes(type)) return { kind: "ignored", reason: "trigger is not enabled for this connector" };

    let status: "firing" | "resolved" = "firing";
    const stateChange = asString(trigger.stateChange, 40);
    if (type === "errorStateManualChange") {
      if (stateChange === "fixed") status = "resolved";
      else if (stateChange !== "reopened" && stateChange !== "unignored") return { kind: "ignored", reason: "this error state change is not an alert" };
    }

    const project = asRecord(root.project);
    const error = asRecord(root.error);
    const projectId = asString(project?.id, 120);
    const errorGroupId = asString(error?.errorId, 120) ?? asString(error?.id, 120);
    let fingerprint: string;
    if (type === "projectSpiking") {
      if (!projectId) return { kind: "invalid", issues: ["projectSpiking needs project.id"] };
      fingerprint = `spike:${projectId}`;
    } else if (ERROR_TRIGGERS_NEED_ERROR.has(type)) {
      if (!errorGroupId) return { kind: "invalid", issues: ["this trigger needs error.errorId or error.id"] };
      fingerprint = `error:${errorGroupId}`;
    } else {
      return { kind: "ignored", reason: "unsupported Bugsnag trigger" };
    }

    const receivedAtRaw = asString(error?.receivedAt, 60);
    const subject = asString(error?.id, 120) ?? projectId ?? "unknown";
    const externalId = [type, ...(type === "errorStateManualChange" && stateChange ? [stateChange] : []), subject, receivedAtRaw ?? req.receivedAt.toISOString()].join(":");

    const app = asRecord(error?.app);
    const severityValue = asString(error?.severity, 40);
    const severity: Severity = mapSeverity(severityValue, config.severityMap ?? DEFAULT_BUGSNAG_SEVERITY, type === "projectSpiking" ? "sev2" : "sev3");
    const attributes = sanitizeAttributes({
      trigger: type,
      ...(stateChange ? { stateChange } : {}),
      triggerMessage: asString(trigger.message, 500),
      releaseStage: asString(app?.releaseStage, 120),
      appVersion: asString(app?.version, 120),
      context: asString(error?.context, 300),
      exceptionClass: asString(error?.exceptionClass, 200) ?? asString(firstException(error ?? {})?.errorClass, 200),
      unhandled: typeof error?.unhandled === "boolean" ? error.unhandled : null,
      status: asString(error?.status, 40),
    });

    const candidate = {
      source: BUGSNAG_SOURCE,
      externalId: asString(externalId, 200) ?? "unknown",
      fingerprint,
      service: asString(project?.name, 120),
      title: titleOf(error, trigger),
      severity,
      status,
      startedAt: toIsoOrNull(error?.receivedAt) ?? toIsoOrNull(error?.firstReceived) ?? req.receivedAt.toISOString(),
      url: httpUrlOrNull(error?.url) ?? httpUrlOrNull(project?.url),
      signal: "error_events" as const,
      attributes,
    };
    const parsed = NormalizedAlertSchema.safeParse(candidate);
    if (!parsed.success) return { kind: "invalid", issues: ["payload does not describe a valid alert"] };
    return { kind: "alerts", alerts: [parsed.data] };
  } catch {
    return { kind: "invalid", issues: ["payload could not be read"] };
  }
}
