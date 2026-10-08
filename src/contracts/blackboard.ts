// Estado do grafo (blackboard) e saídas estruturadas do LLM (spec 5.2).
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
    history: z.array(z.string()), // versões que aparecem no histórico de deploys do serviço, da mais antiga à mais nova
  })),
  inventory: InventorySchema.nullable(),
  // Inventário do início do incidente: base da economia de cada achado (spec 5.7) e do valor anterior numa reversão.
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
  timeOffsetSec: z.number().int(), // deslocamento aplicado às séries para alinhar o alerta ao relógio (0 no relógio simulado)
  alert: AlertSchema,
  diagnosis: DiagnosisSchema.nullable(),
  telemetryRuns: z.number().int().min(0).max(2),
  runbookMatches: z.array(RunbookMatchSchema),
  runbookSearchDone: z.boolean(),
  plan: RemediationPlanSchema.nullable(),
  planRevision: z.number().int().min(0).max(2),
  audit: AuditReviewSchema.nullable(),
  actions: z.array(GatedActionSchema),
  world: WorldStateSchema, // estado do mundo simulado (event sourcing)
  verification: VerificationSchema.nullable(),
  metrics: IncidentMetricsSchema.nullable(),
  postmortem: PostmortemDocSchema.nullable(),
  supervisor: z.object({ iterations: z.number().int().min(0), history: z.array(HandoffRecordSchema) }),
  escalation: EscalationSchema.nullable(),
});

// Saídas de LLM
export const SupervisorDecisionSchema = z.object({
  next: z.enum(["telemetry_analyst", "runbook_retriever", "remediation_planner", "gate", "reporter", "done"]),
  brief: z.string().max(300).describe("Instrução curta ao especialista escolhido"),
  reason: z.string().max(300).describe("Por que este é o próximo passo; vira trilha de auditoria"),
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

// Tetos injetados pela fábrica (spec 6.2).
export const LimitsSchema = z.object({
  reactMaxSteps: z.number().int().positive().default(12),
  maxTelemetryRuns: z.number().int().positive().default(2),
  teamMaxIterations: z.number().int().positive().default(8),
  recursionLimit: z.number().int().positive().default(25),
  maxPlanRevisions: z.number().int().nonnegative().default(2),
});
