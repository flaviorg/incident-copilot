// Sentry connector config (docs/connectors/sentry.md). Two independent blocks: `ingest` receives the signed webhooks of
// an internal integration; `query` reads issues and releases over the REST API. At least one is required.
import * as z from "zod";
import type { Severity } from "../../contracts/index.ts";
import type { ConfigHelpers } from "../shared/config-helpers.ts";

export const SENTRY_RESOURCES = ["event_alert", "metric_alert", "issue"] as const;
export type SentryResource = (typeof SENTRY_RESOURCES)[number];

export const DEFAULT_SENTRY_BASE_URL = "https://sentry.io";
const ORGANIZATION = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function sentryConfigSchema(h: ConfigHelpers) {
  return z
    .strictObject({
      ingest: z
        .strictObject({
          /** The integration's Client Secret: the HMAC key of Sentry-Hook-Signature. */
          clientSecret: h.secret({ min: 8 }),
          allowedIps: z.array(z.union([z.ipv4(), z.ipv6()])).min(1).max(50).optional(),
          resources: z.array(z.enum(SENTRY_RESOURCES)).min(1).max(3).default([...SENTRY_RESOURCES]),
        })
        .optional(),
      query: z
        .strictObject({
          baseUrl: h.url().default(DEFAULT_SENTRY_BASE_URL),
          organization: h.text({ max: 64 }).pipe(z.string().regex(ORGANIZATION, { message: "must be an organization slug" })),
          /** Auth token of the internal integration (read access). */
          token: h.secret({ min: 16 }),
          environment: h.text({ max: 64 }).optional(),
        })
        .optional(),
    })
    .refine((c) => c.ingest !== undefined || c.query !== undefined, { message: "declare at least one of ingest or query" });
}

export type SentryConfig = z.infer<ReturnType<typeof sentryConfigSchema>>;

/** Event and issue levels. fatal is sev1; the rest of the Sentry levels are sev3 unless an alert escalates it. */
export const DEFAULT_SENTRY_LEVEL_SEVERITY: Readonly<Record<string, Severity>> = { fatal: "sev1", error: "sev2", warning: "sev3", info: "sev3", debug: "sev3" };
/** Metric alert actions (the alert rule's trigger label). */
export const DEFAULT_SENTRY_METRIC_SEVERITY: Readonly<Record<string, Severity>> = { critical: "sev1", warning: "sev2" };
