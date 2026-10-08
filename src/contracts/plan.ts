import * as z from "zod";

export const PlanStepSchema = z.object({
  order: z.number().int().min(1).max(8),
  actionType: z.string().min(1).max(64).describe("Action catalog type. A type not in the catalog will be blocked."),
  target: z.string().min(1).max(200).describe("Target resource, e.g. deployment/orders-api"),
  params: z.record(z.string(), z.unknown()),
  rationale: z.string().max(300),
  runbookRef: z.string().nullable().describe("runbookId#section used as the basis, or null"),
  dependsOn: z.array(z.number().int().min(1)),
});

export const RemediationPlanSchema = z.object({
  summary: z.string().max(400),
  steps: z.array(PlanStepSchema).min(1).max(8),
});
