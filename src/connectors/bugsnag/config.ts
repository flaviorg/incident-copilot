// Bugsnag connector config (docs/connectors/bugsnag.md). The Data Forwarding webhook carries no signature or secret
// header, so the only credential is a secret token in the URL path (/ingest/<id>/<token>), optionally combined with
// an IP allowlist. The query side is the Data Access API v2 with a personal auth token.
import * as z from "zod";
import type { Severity } from "../../contracts/index.ts";
import type { ConfigHelpers } from "../shared/config-helpers.ts";

/** The token goes into a URL path, so it must be path-safe (same rule as the shared path_token scheme). */
const PATH_TOKEN = /^[A-Za-z0-9_-]{24,128}$/;
/** Project ids go into a URL path too. Bugsnag ids are 24 hex characters; the rule is deliberately wider. */
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Triggers that can open or resolve an incident. comment, release, projectSamplingStarted and projectApproachingRateLimit never do. */
export const BUGSNAG_ALERT_TRIGGERS = [
  "exception", "firstException", "errorEventFrequency", "powerTen", "projectSpiking", "reopened", "errorStateManualChange",
] as const;
export type BugsnagAlertTrigger = (typeof BUGSNAG_ALERT_TRIGGERS)[number];

export const BUGSNAG_DEFAULT_BASE_URL = "https://api.bugsnag.com";

export function bugsnagConfigSchema(h: ConfigHelpers) {
  return z
    .strictObject({
      ingest: z
        .strictObject({
          token: h.secret({ min: 24 }).pipe(z.string().regex(PATH_TOKEN, { message: "must contain only A-Z, a-z, 0-9, _ and -" })),
          allowedIps: z.array(z.union([z.ipv4(), z.ipv6()])).min(1).max(50).optional(),
          triggers: z.array(z.enum(BUGSNAG_ALERT_TRIGGERS)).min(1).max(BUGSNAG_ALERT_TRIGGERS.length).default([...BUGSNAG_ALERT_TRIGGERS]),
        })
        .optional(),
      query: z
        .strictObject({
          baseUrl: h.url().default(BUGSNAG_DEFAULT_BASE_URL),
          token: h.secret({ min: 16 }),
          /** Bugsnag project name (the alias used in services[].aliases) to project id. */
          projects: z.record(z.string().min(1).max(120), z.string().regex(PROJECT_ID, { message: "must be a Bugsnag project id" })).refine((p) => Object.keys(p).length >= 1, { message: "at least one project" }),
        })
        .optional(),
    })
    .refine((c) => c.ingest !== undefined || c.query !== undefined, { message: "configure ingest, query or both" });
}

export type BugsnagConfig = z.infer<ReturnType<typeof bugsnagConfigSchema>>;

/** Used when the copilot.yaml entry has no severityMap. Keys are the Bugsnag error severities. */
export const DEFAULT_BUGSNAG_SEVERITY: Readonly<Record<string, Severity>> = { error: "sev2", warning: "sev3", info: "sev3" };
