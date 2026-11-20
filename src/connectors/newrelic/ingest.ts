// New Relic workflow webhook (the documented template in docs/connectors/newrelic.md) to a NormalizedAlert. Pure and
// defensive: a payload of unexpected shape is invalid or ignored, never an exception. Every text goes through
// sanitizeText. New Relic documents no request signing, so authentication is the destination's Bearer, Basic or header.
import { NormalizedAlertSchema } from "../../contracts/index.ts";
import type { Severity } from "../../contracts/index.ts";
import { sanitizeAttributes } from "../../domain/ingest/sanitize.ts";
import { mapSeverity } from "../../domain/ingest/severity.ts";
import { asRecord, asString, httpUrlOrNull, toIsoOrNull } from "../shared/parse-utils.ts";
import type { InboundRequest, ParseOutcome } from "../types.ts";
import { DEFAULT_NEWRELIC_SEVERITY } from "./config.ts";

export const NEWRELIC_SOURCE = "newrelic";
const MAX_DEPTH = 4;
const MAX_ITEMS = 50;

/** A sanitized string; an array yields its first readable element (Handlebars may render a list for a single value). */
function scalar(v: unknown, max: number): string | null {
  if (Array.isArray(v)) {
    for (const item of v.slice(0, MAX_ITEMS)) {
      const s = typeof item === "string" || typeof item === "number" ? asString(item, max) : null;
      if (s !== null) return s;
    }
    return null;
  }
  return asString(v, max);
}

/**
 * The first name (or type) of {{json entitiesData}}, whose rendered shape is unverified. Accepts {names: [...]},
 * {entities: [{name}]}, an array of {name}, an array of strings and a plain string.
 */
function firstEntityField(v: unknown, listKey: "names" | "types", itemKey: "name" | "type", max: number, depth = 0): string | null {
  if (depth > MAX_DEPTH) return null;
  if (typeof v === "string") return asString(v, max);
  if (Array.isArray(v)) {
    for (const item of v.slice(0, MAX_ITEMS)) {
      const s = firstEntityField(item, listKey, itemKey, max, depth + 1);
      if (s !== null) return s;
    }
    return null;
  }
  const r = asRecord(v);
  if (!r) return null;
  for (const key of [listKey, "entities", itemKey]) {
    if (!Object.hasOwn(r, key)) continue;
    const s = firstEntityField(r[key], listKey, itemKey, max, depth + 1);
    if (s !== null) return s;
  }
  return null;
}

export function parseNewRelicPayload(
  body: unknown,
  req: InboundRequest,
  config: { severityMap: Readonly<Record<string, Severity>> | null },
): ParseOutcome {
  try {
    const root = asRecord(body);
    if (!root) return { kind: "invalid", issues: ["body must be a JSON object"] };
    const issueId = asString(root.issueId, 120);
    if (issueId === null) return { kind: "invalid", issues: ["issueId is required"] };
    const state = typeof root.state === "string" ? root.state.trim().toUpperCase() : "";
    const status = state === "CLOSED" ? "resolved" : state === "ACTIVATED" || state === "CREATED" ? "firing" : null;
    if (status === null) return { kind: "ignored", reason: "state is not CREATED, ACTIVATED or CLOSED" };

    const received = req.receivedAt.toISOString();
    const stamp = asString(root.updatedAt, 60) ?? asString(root.createdAt, 60) ?? received;
    // A closed issue carries its close time; setIncidentResolved takes the provider's time from startedAt.
    const startedAt = (status === "resolved" ? (toIsoOrNull(root.closedAt) ?? toIsoOrNull(root.updatedAt)) : toIsoOrNull(root.createdAt)) ?? received;
    const priority = scalar(root.priority, 40);
    const entities = root.entitiesData;

    const candidate = {
      source: NEWRELIC_SOURCE,
      externalId: `${issueId}:${state}:${stamp}`.slice(0, 200),
      fingerprint: `issue:${issueId}`,
      service: firstEntityField(entities, "names", "name", 120),
      title: asString(root.title, 200) ?? `New Relic issue ${issueId}`,
      severity: mapSeverity(priority, config.severityMap ?? DEFAULT_NEWRELIC_SEVERITY, "sev2"),
      status,
      startedAt,
      url: httpUrlOrNull(root.issuePageUrl),
      signal: "other" as const,
      attributes: sanitizeAttributes({
        ...(priority ? { priority } : {}),
        state,
        ...Object.fromEntries(
          (["triggerEvent", "workflowName", "conditionName", "policyName"] as const)
            .map((k) => [k, scalar(root[k], 200)] as const)
            .filter((e): e is [typeof e[0], string] => e[1] !== null),
        ),
        ...(() => {
          const t = firstEntityField(entities, "types", "type", 60);
          return t ? { entityType: t } : {};
        })(),
      }),
    };
    const parsed = NormalizedAlertSchema.safeParse(candidate);
    if (!parsed.success) return { kind: "invalid", issues: ["payload does not describe a valid alert"] };
    return { kind: "alerts", alerts: [parsed.data] };
  } catch {
    return { kind: "invalid", issues: ["payload could not be read"] };
  }
}
