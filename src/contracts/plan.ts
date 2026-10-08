import * as z from "zod";

export const PlanStepSchema = z.object({
  order: z.number().int().min(1).max(8),
  actionType: z.string().min(1).max(64).describe("Tipo do catálogo de ações. Tipo fora do catálogo será bloqueado."),
  target: z.string().min(1).max(200).describe("Recurso alvo, ex.: deployment/orders-api"),
  params: z.record(z.string(), z.unknown()),
  rationale: z.string().max(300),
  runbookRef: z.string().nullable().describe("runbookId#secao usada como base, ou null"),
  dependsOn: z.array(z.number().int().min(1)),
});

export const RemediationPlanSchema = z.object({
  summary: z.string().max(400),
  steps: z.array(PlanStepSchema).min(1).max(8),
});
