import * as z from "zod";
import { AgentIdSchema, TierSchema } from "./enums.ts";
import { PlanStepSchema } from "./plan.ts";

const TraceBase = z.object({
  id: z.string(),
  incidentId: z.string(),
  runId: z.string(),
  requestId: z.string().nullable(),
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  agent: AgentIdSchema,
  llm: z.object({
    model: z.string(),
    promptVersion: z.string(),
    promptTokens: z.number().int(),
    completionTokens: z.number().int(),
    costUsd: z.number().nonnegative(),
    latencyMs: z.number().int(),
  }).nullable(),
});

export const TraceLlmSchema = TraceBase.shape.llm;

export const TraceEventSchema = z.discriminatedUnion("type", [
  TraceBase.extend({ type: z.literal("thought"), payload: z.object({ text: z.string().max(1000) }) }),
  TraceBase.extend({ type: z.literal("action"), payload: z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()), tier: TierSchema.nullable() }) }),
  TraceBase.extend({ type: z.literal("observation"), payload: z.object({ tool: z.string(), ok: z.boolean(), summary: z.string().max(600), evidenceRef: z.string().nullable() }) }),
  TraceBase.extend({ type: z.literal("plan"), payload: z.object({ revision: z.number().int(), summary: z.string(), steps: z.array(PlanStepSchema) }) }),
  TraceBase.extend({ type: z.literal("critique"), payload: z.object({
    by: z.enum(["auditor", "supervisor_guard", "gate", "numeric_guard", "canary"]),
    verdict: z.enum(["approve", "revise", "reject", "coerced", "blocked"]),
    feedback: z.string().max(600),
    // Só o auditor preenche: o veredito do modelo foi endurecido pelas regras em código (o /stats conta este campo).
    overridden: z.boolean().optional(),
  }) }),
  TraceBase.extend({ type: z.literal("answer"), payload: z.object({ kind: z.enum(["diagnosis", "postmortem", "escalation"]), text: z.string().max(2000) }) }),
  TraceBase.extend({ type: z.literal("handoff"), payload: z.object({ from: AgentIdSchema, to: AgentIdSchema, brief: z.string().max(400), reason: z.string().max(400) }) }),
]);
