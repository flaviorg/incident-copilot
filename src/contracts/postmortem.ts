import * as z from "zod";
import { ActionStatusSchema, EscalationReasonSchema, RootCauseCategorySchema, TierSchema } from "./enums.ts";
import { EvidenceSchema } from "./diagnosis.ts";
import { IncidentMetricsSchema } from "./metrics.ts";

export const PostmortemDocSchema = z.object({
  incidentId: z.string(),
  title: z.string(),
  status: z.enum(["final", "partial"]),
  summary: z.string(),
  impact: z.object({ service: z.string(), durationMin: z.number().nullable(), peakErrorRate: z.number().nullable(), monthlySavingsUsd: z.number() }),
  timeline: z.array(z.object({ ts: z.string(), text: z.string() })), // determinístico
  rootCause: z.object({ category: RootCauseCategorySchema, narrative: z.string(), evidence: z.array(EvidenceSchema) }),
  actions: z.array(z.object({ actionType: z.string(), tier: TierSchema, status: ActionStatusSchema, decidedBy: z.string().nullable() })),
  metrics: IncidentMetricsSchema,
  prevention: z.array(z.string()),
  escalation: z.object({ reason: EscalationReasonSchema, detail: z.string() }).nullable(),
  // model = "template" quando não houve narrativa do LLM
  generatedBy: z.object({ provider: z.enum(["fake", "openrouter"]), model: z.string(), promptVersion: z.string() }),
  numericGuard: z.object({ passed: z.boolean(), rejectedNumbers: z.array(z.string()), usedTemplate: z.boolean() }),
});
