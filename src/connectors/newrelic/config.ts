// New Relic connector config (docs/connectors/newrelic.md). Ingest authenticates the workflow webhook destination
// (Bearer, Basic or a custom header: New Relic documents no request signing). Query reads NerdGraph NRQL with a user
// API key through templates the operator owns.
import * as z from "zod";
import type { Severity } from "../../contracts/index.ts";
import { webhookAuthSchema } from "../shared/auth.ts";
import type { ConfigHelpers } from "../shared/config-helpers.ts";
import { DEFAULT_NRQL, MAX_TEMPLATE_LENGTH, validateNrqlTemplate } from "./nrql.ts";
import type { NrqlPlaceholder } from "./nrql.ts";

export const METRIC_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_METRICS = 20;

export const TEMPLATE_PLACEHOLDERS = {
  metrics: ["service", "since", "until"],
  errors: ["service", "since", "until", "limit"],
  logs: ["service", "since", "until", "limit", "level"],
  deploys: ["service", "since", "until", "limit"],
} as const satisfies Record<string, readonly NrqlPlaceholder[]>;

const template = (allowed: readonly NrqlPlaceholder[]) =>
  z.string().max(MAX_TEMPLATE_LENGTH).superRefine((t, ctx) => {
    const problem = validateNrqlTemplate(t, allowed);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  });

export function newRelicConfigSchema(h: ConfigHelpers) {
  return z
    .strictObject({
      ingest: z.strictObject({ auth: webhookAuthSchema(h, ["bearer", "basic", "header"]) }).optional(),
      query: z
        .strictObject({
          region: z.enum(["us", "eu"]).default("us"),
          accountId: z.number().int().positive(),
          apiKey: h.secret({ min: 16 }),
          nrql: z
            .strictObject({
              /** Extra or overriding metric templates, by metric name; the three default metrics stay unless overridden. */
              metrics: z
                .record(z.string().regex(METRIC_NAME), template(TEMPLATE_PLACEHOLDERS.metrics))
                .refine((m) => Object.keys(m).length <= MAX_METRICS, { message: `at most ${MAX_METRICS} metrics` })
                .optional(),
              /** A template overrides the default; null turns the capability off. */
              errors: template(TEMPLATE_PLACEHOLDERS.errors).nullable().optional(),
              logs: template(TEMPLATE_PLACEHOLDERS.logs).nullable().optional(),
              deploys: template(TEMPLATE_PLACEHOLDERS.deploys).nullable().optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .refine((c) => c.ingest !== undefined || c.query !== undefined, { message: "ingest or query is required" });
}

export type NewRelicConfig = z.infer<ReturnType<typeof newRelicConfigSchema>>;
export type NewRelicQueryConfig = NonNullable<NewRelicConfig["query"]>;

/** Used when the copilot.yaml entry has no severityMap (issue priority → incident severity). */
export const DEFAULT_NEWRELIC_SEVERITY: Readonly<Record<string, Severity>> = { CRITICAL: "sev1", HIGH: "sev2", MEDIUM: "sev3", LOW: "sev3" };

export type ResolvedTemplates = {
  metrics: Readonly<Record<string, string>>;
  errors: string | null;
  logs: string | null;
  deploys: string | null;
};

/** The templates in force: the defaults, overridden per name; null switches errors, logs or deploys off. */
export function resolveTemplates(nrql: NewRelicQueryConfig["nrql"]): ResolvedTemplates {
  const pick = (v: string | null | undefined, fallback: string): string | null => (v === undefined ? fallback : v);
  return {
    metrics: { ...DEFAULT_NRQL.metrics, ...(nrql?.metrics ?? {}) },
    errors: pick(nrql?.errors, DEFAULT_NRQL.errors),
    logs: pick(nrql?.logs, DEFAULT_NRQL.logs),
    deploys: pick(nrql?.deploys, DEFAULT_NRQL.deploys),
  };
}
