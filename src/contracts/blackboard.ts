// Graph state (blackboard) and structured LLM outputs (spec 5.2).
import * as z from "zod";
import { AgentIdSchema, PhaseSchema } from "./enums.ts";
import { AlertSchema, EscalationSchema } from "./incident.ts";
import { DiagnosisSchema } from "./diagnosis.ts";
import { RemediationPlanSchema } from "./plan.ts";
import { AuditReviewSchema } from "./audit.ts";
import { GatedActionSchema } from "./actions.ts";
import { IncidentMetricsSchema } from "./metrics.ts";
import { PostmortemDocSchema } from "./postmortem.ts";
import { InventorySchema, MetricNameSchema } from "./scenario.ts";

export const WorldStateSchema = z.object({
  deployments: z.record(z.string(), z.object({
    version: z.string(),
    previousVersion: z.string(),
    replicas: z.number().int().nonnegative(),
    blockedTags: z.array(z.string()),
    history: z.array(z.string()), // versions that appear in the service's deploy history, oldest to newest
  })),
  inventory: InventorySchema.nullable(),
  // Inventory at the start of the incident: basis of each finding's savings (spec 5.7) and of the previous value in a rollback.
  initialInventory: InventorySchema.nullable(),
  notes: z.array(z.string()),
  tagsForReview: z.array(z.string()),
  snapshots: z.array(z.string()),
});

export const CanaryCheckResultSchema = z.object({
  metric: MetricNameSchema,
  observed: z.number().nullable(),
  limit: z.number(),
  passed: z.boolean(),
});

export const VerificationSchema = z.object({
  healthy: z.boolean(),
  checks: z.array(CanaryCheckResultSchema),
  revertedActionIds: z.array(z.string()),
});

export const HandoffRecordSchema = z.object({
  iteration: z.number().int().nonnegative(),
  from: AgentIdSchema,
  to: AgentIdSchema,
  brief: z.string().max(400),
  reason: z.string().max(400),
  coerced: z.boolean(),
});

export const RunbookMatchSchema = z.object({
  runbookId: z.string(),
  version: z.string(),
  section: z.string(),
  score: z.number(),
  normalizedScore: z.number().min(0).max(1),
  excerpt: z.string().max(400),
});

export const BlackboardSchema = z.object({
  incidentId: z.string(),
  scenarioId: z.string(),
  runId: z.string(),
  phase: PhaseSchema,
  timeOffsetSec: z.number().int(), // offset applied to the series to align the alert with the clock (0 on the simulated clock)
  alert: AlertSchema,
  diagnosis: DiagnosisSchema.nullable(),
  telemetryRuns: z.number().int().min(0).max(2),
  runbookMatches: z.array(RunbookMatchSchema),
  runbookSearchDone: z.boolean(),
  plan: RemediationPlanSchema.nullable(),
  planRevision: z.number().int().min(0).max(2),
  audit: AuditReviewSchema.nullable(),
  actions: z.array(GatedActionSchema),
  world: WorldStateSchema, // simulated world state (event sourcing)
  verification: VerificationSchema.nullable(),
  metrics: IncidentMetricsSchema.nullable(),
  postmortem: PostmortemDocSchema.nullable(),
  supervisor: z.object({ iterations: z.number().int().min(0), history: z.array(HandoffRecordSchema) }),
  escalation: EscalationSchema.nullable(),
});

// LLM outputs
export const SupervisorDecisionSchema = z.object({
  next: z.enum(["telemetry_analyst", "runbook_retriever", "remediation_planner", "gate", "reporter", "done"]),
  brief: z.string().max(300).describe("Short instruction to the chosen specialist"),
  reason: z.string().max(300).describe("Why this is the next step; becomes part of the audit trail"),
});

export const ReactStepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("action"), thought: z.string().max(600), tool: z.string(), args: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("final"), thought: z.string().max(600), diagnosis: DiagnosisSchema.omit({ capReached: true }) }),
]);

export const AuditorVerdictSchema = z.object({ verdict: z.enum(["approve", "revise"]), feedback: z.string().max(600) });

export const PostmortemNarrativeSchema = z.object({
  summary: z.string().max(800),
  rootCauseNarrative: z.string().max(1200),
  prevention: z.array(z.string().max(200)).min(1).max(6),
});

// Caps injected by the factory (spec 6.2).
export const LimitsSchema = z.object({
  reactMaxSteps: z.number().int().positive().default(12),
  maxTelemetryRuns: z.number().int().positive().default(2),
  teamMaxIterations: z.number().int().positive().default(8),
  recursionLimit: z.number().int().positive().default(25),
  maxPlanRevisions: z.number().int().nonnegative().default(2),
});
