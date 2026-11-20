// Incident metrics (spec 5.7). Each value has a measured, assumption or derived label in `sources`.
import * as z from "zod";

export const RangeSchema = z.object({ low: z.number(), high: z.number() });

export const MetricSourceSchema = z.enum(["measured", "assumption", "derived"]);

export const IncidentMetricsSchema = z.object({
  impactStartedAt: z.string(),
  detectedAt: z.string(),
  resolvedAt: z.string().nullable(),
  mttdMin: z.number(),
  mttrMin: z.number().nullable(),
  timeAwaitingApprovalMin: z.number(),
  baselineMttrMin: RangeSchema, // synthetic assumption
  minutesSaved: RangeSchema.nullable(),
  impactFraction: z.number().min(0).max(1),
  revenuePerMinuteUsd: z.number(),
  downtimeCostAvoidedUsd: RangeSchema,
  engineeringCostSavedUsd: RangeSchema,
  monthlySavingsUsd: z.number(),
  llmCostUsd: z.number(),
  copilotCostUsd: z.number(),
  roiIllustrative: RangeSchema.nullable(),
  llmCalls: z.number().int(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  assumptionsVersion: z.string(),
  sources: z.record(z.string(), MetricSourceSchema),
});
