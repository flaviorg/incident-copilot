// Formato dos cenários de demo em fixtures/scenarios/<id>/ (spec 7.3). Dados próprios, gerados por especificação determinística.
import * as z from "zod";
import { RootCauseCategorySchema, SeveritySchema } from "./enums.ts";

export const MetricNameSchema = z.enum(["http_5xx_rate", "p99_latency_ms", "request_rate", "daily_cost_usd", "projected_monthly_cost_usd"]);
export const MetricWindowSchema = z.enum(["15m", "30m", "60m", "24h", "7d"]);

export const SeriesSegmentSchema = z.discriminatedUnion("kind", [
  z.object({ fromSec: z.number().nonnegative(), toSec: z.number().nonnegative(), kind: z.literal("constant"), value: z.number() }),
  z.object({ fromSec: z.number().nonnegative(), toSec: z.number().nonnegative(), kind: z.literal("linear"), startValue: z.number(), endValue: z.number() }),
]);

export const SeriesSpecSchema = z
  .object({
    segments: z.array(SeriesSegmentSchema).min(1),
    noise: z.object({ amplitude: z.number().nonnegative(), seed: z.number().int() }).optional(),
  })
  .superRefine((spec, ctx) => {
    spec.segments.forEach((s, i) => {
      if (s.toSec <= s.fromSec) ctx.addIssue({ code: "custom", path: ["segments", i, "toSec"], message: "toSec must be greater than fromSec" });
    });
  });

export const SeriesPointSchema = z.object({ ts: z.string(), value: z.number() });

export const SignalsFileSchema = z.object({
  start: z.iso.datetime(),
  durationSec: z.number().int().positive(),
  resolutionSec: z.number().int().positive(),
  series: z.partialRecord(MetricNameSchema, SeriesSpecSchema),
});

export const LogLineSchema = z.object({
  ts: z.iso.datetime(),
  level: z.enum(["ERROR", "WARN", "INFO"]),
  service: z.string().min(1),
  version: z.string().min(1),
  message: z.string().min(1),
  count: z.number().int().min(1),
});

export const DeploySchema = z.object({
  service: z.string().min(1),
  version: z.string().min(1),
  previousVersion: z.string().min(1),
  at: z.iso.datetime(),
  replicas: z.number().int().positive(),
});
export const DeploysFileSchema = z.array(DeploySchema);

export const InventorySchema = z.object({
  account: z.string().min(1),
  region: z.string().min(1),
  volumes: z.array(z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    sizeGb: z.number().positive(),
    attachedTo: z.string().nullable(),
    unattachedDays: z.number().int().nonnegative(),
  })),
  publicIps: z.array(z.object({ id: z.string().min(1), associatedWith: z.string().nullable() })),
  instances: z.array(z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    avgCpuPct14d: z.number().min(0).max(100),
    role: z.string(),
  })),
  backupVaults: z.array(z.object({
    id: z.string().min(1),
    monthlyCostUsd: z.number().nonnegative(),
    oldestRecoveryPointDays: z.number().int().nonnegative(),
  })),
});

export const CanaryCheckSchema = z
  .object({
    metric: MetricNameSchema,
    op: z.literal("<="),
    threshold: z.number().optional(),
    baselineFactor: z.number().positive().optional(),
  })
  .refine((c) => (c.threshold === undefined) !== (c.baselineFactor === undefined), {
    message: "use exactly one of threshold and baselineFactor",
    path: ["threshold"],
  });

export const ScenarioFileSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string().min(1),
    summary: z.string().min(1),
    service: z.string().min(1).nullable(),
    account: z.string().min(1).nullable(),
    severity: SeveritySchema,
    expectedCategory: RootCauseCategorySchema,
    alert: z.object({
      signal: MetricNameSchema,
      threshold: z.number().nullable(),
      detectedAt: z.iso.datetime(),
      rule: z.string().min(1),
    }),
    baselines: z.partialRecord(MetricNameSchema, z.number()).default({}),
    canary: z.array(CanaryCheckSchema).min(1),
    demo: z.object({ approvalLatencySec: z.number().int().nonnegative() }),
    // Falhas injetáveis na execução simulada: "<actionType>@<target>": "fail".
    faults: z.record(z.string(), z.literal("fail")).default({}),
  })
  .refine((s) => s.service !== null || s.account !== null, { message: "set service or account", path: ["service"] });

export const AfterFileSchema = z.object({
  windowSec: z.number().int().positive(),
  resolutionSec: z.number().int().positive(),
  variants: z.array(z.object({
    when: z.record(z.string(), z.string()),
    series: z.partialRecord(MetricNameSchema, SeriesSpecSchema),
  })).min(1),
});

export const ScenarioSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  service: z.string().nullable(),
  account: z.string().nullable(),
  severity: SeveritySchema,
});
