import * as z from "zod";
import { TierSchema } from "./enums.ts";

export const AuditCheckSchema = z.object({ rule: z.string(), passed: z.boolean(), detail: z.string().max(300) });

export const AuditReviewSchema = z.object({
  verdict: z.enum(["approve", "revise"]),
  feedback: z.string().max(600),
  checks: z.array(AuditCheckSchema),
  llmVerdict: z.enum(["approve", "revise"]).nullable(),
  overridden: z.boolean(),
});

export const AuditEventSchema = z.enum([
  "incident_opened", "action_blocked_forbidden", "action_blocked_unknown", "action_rejected_invalid_params", "action_dry_run_failed", "action_ready",
  "action_executed", "action_failed", "action_throttled", "action_blocked_circuit_open", "action_cancelled",
  "approval_requested", "approval_approved", "approval_rejected", "approval_expired", "approval_auth_failed",
  "canary_rollback", "circuit_opened", "incident_escalated", "incident_resolved",
]);

// Linha da trilha de auditoria (spec 6.8): encadeada por hash.
export const AuditEntrySchema = z.object({
  id: z.string(),
  ts: z.string(),
  incidentId: z.string(),
  actor: z.string(), // agent:<id>, human:<nome>, system:<componente>, mcp_client:<nome>
  event: AuditEventSchema,
  tier: TierSchema.nullable(),
  details: z.record(z.string(), z.unknown()),
  prevHash: z.string().regex(/^[0-9a-f]{64}$/),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});
