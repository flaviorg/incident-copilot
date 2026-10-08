import * as z from "zod";
import { EscalationReasonSchema, IncidentStatusSchema, LlmErrorKindSchema, SeveritySchema } from "./enums.ts";
import { MetricNameSchema } from "./scenario.ts";

export const AlertSchema = z.object({
  title: z.string(),
  service: z.string().nullable(),
  account: z.string().nullable(),
  signal: MetricNameSchema,
  threshold: z.number().nullable(),
  rule: z.string(),
  detectedAt: z.string(),
  severity: SeveritySchema,
});

export const EscalationSchema = z.object({ reason: EscalationReasonSchema, detail: z.string().max(400) });

export const IncidentSchema = z.object({
  id: z.string(),
  title: z.string(),
  service: z.string().nullable(),
  severity: SeveritySchema,
  status: IncidentStatusSchema,
  scenarioId: z.string(),
  openedAt: z.string(),
  impactStartedAt: z.string(),
  detectedAt: z.string(),
  resolvedAt: z.string().nullable(),
  escalation: EscalationSchema.nullable(),
});

// Uma linha por chamada de LLM (spec 6.9).
export const LlmCallRecordSchema = z.object({
  incidentId: z.string(),
  runId: z.string(),
  promptVersion: z.string(),
  model: z.string(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  success: z.boolean(),
  errorKind: LlmErrorKindSchema.nullable(),
  ts: z.string(),
});

// Uma linha por invocação do grafo (spec 6.9). `outcome` é o status derivado ao fim, ou null enquanto roda.
export const RunRecordSchema = z.object({
  id: z.string(),
  incidentId: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  outcome: z.string().max(60).nullable(),
});
