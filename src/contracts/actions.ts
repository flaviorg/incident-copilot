import * as z from "zod";
import { ActionStatusSchema, TierSchema } from "./enums.ts";

export const DryRunResultSchema = z.object({
  ok: z.boolean(),
  changes: z.array(z.string()).max(10), // "deployment/orders-api: v3.8.0 -> v3.7.2 (6 réplicas)"
  reversible: z.boolean(),
  estimatedDurationSec: z.number().int().nonnegative(),
  failureReason: z.string().nullable(),
});

export const GatedActionSchema = z.object({
  id: z.string(),
  incidentId: z.string(),
  planRevision: z.number().int().nullable(), // null quando proposedBy = mcp_client
  order: z.number().int(),
  actionType: z.string(),
  target: z.string(),
  params: z.record(z.string(), z.unknown()),
  dependsOn: z.array(z.number().int()),
  tier: TierSchema,
  classificationReasons: z.array(z.string()),
  status: ActionStatusSchema,
  dryRun: DryRunResultSchema.nullable(),
  approvalId: z.string().nullable(),
  proposedBy: z.enum(["remediation_planner", "mcp_client"]),
  executedAt: z.string().nullable(),
  resultSummary: z.string().nullable(),
});
