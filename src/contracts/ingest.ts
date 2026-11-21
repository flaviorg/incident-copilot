// Live ingest contracts (spec 008): the normalized alert every connector produces, the ingest record and the incident origin.
// Browser-safe: only imports zod and sibling contracts.
import * as z from "zod";
import { SeveritySchema } from "./enums.ts";
import { MetricNameSchema } from "./scenario.ts";

/** At most this many attribute keys on a normalized alert. */
export const MAX_ALERT_ATTRIBUTES = 20;

export const ConnectorIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

/** What the alert measures: a scenario metric, error events (Sentry, Bugsnag) or anything else. */
export const AlertSignalSchema = z.enum([...MetricNameSchema.options, "error_events", "other"]);

export const NormalizedAlertSchema = z.object({
  source: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), // connector type, e.g. "sentry"
  externalId: z.string().min(1).max(200), // idempotency key of the provider event
  fingerprint: z.string().min(1).max(200), // grouping key for dedupe
  service: z.string().min(1).max(120).nullable(), // raw name from the payload, mapped later
  title: z.string().min(1).max(200),
  severity: SeveritySchema,
  status: z.enum(["firing", "resolved"]),
  startedAt: z.iso.datetime(), // normalized to toISOString()
  url: z.string().max(2000).nullable(), // http(s) only, else null
  signal: AlertSignalSchema,
  attributes: z
    .record(z.string().max(64), z.string().max(500))
    .refine((a) => Object.keys(a).length <= MAX_ALERT_ATTRIBUTES, { message: `at most ${MAX_ALERT_ATTRIBUTES} attributes` }),
});

export const IngestOutcomeSchema = z.enum(["queued", "opened", "deduplicated", "resolved", "ignored", "failed"]);

export const IngestedAlertRecordSchema = z.object({
  id: z.string(),
  connectorId: ConnectorIdSchema,
  alert: NormalizedAlertSchema,
  receivedAt: z.iso.datetime(),
  requestId: z.string().nullable(),
  outcome: IngestOutcomeSchema,
  incidentId: z.string().nullable(),
  detail: z.string().max(300).nullable(),
});

export const IncidentOriginSchema = z.object({
  kind: z.literal("connector"),
  connectorId: ConnectorIdSchema,
  source: z.string(),
  fingerprint: z.string(),
  alertId: z.string(),
  externalUrl: z.string().nullable(),
  mode: z.literal("shadow"),
});
