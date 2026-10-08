// Ponto único de importação dos contratos: schemas Zod e os tipos inferidos deles.
import type * as z from "zod";

import {
  SeveritySchema, IncidentStatusSchema, PhaseSchema, AgentIdSchema, TierSchema, RootCauseCategorySchema,
  ConfidenceSchema, EscalationReasonSchema, ActionStatusSchema, ApprovalStatusSchema, TraceTypeSchema,
  ReadToolNameSchema, LlmErrorKindSchema,
} from "./enums.ts";
import { EvidenceSchema, DiagnosisSchema } from "./diagnosis.ts";
import { PlanStepSchema, RemediationPlanSchema } from "./plan.ts";
import { DryRunResultSchema, GatedActionSchema } from "./actions.ts";
import { ApprovalSchema } from "./approval.ts";
import { AuditCheckSchema, AuditReviewSchema, AuditEventSchema, AuditEntrySchema } from "./audit.ts";
import { TraceEventSchema, TraceLlmSchema } from "./trace.ts";
import {
  MetricNameSchema, MetricWindowSchema, SeriesSegmentSchema, SeriesSpecSchema, SeriesPointSchema, SignalsFileSchema,
  LogLineSchema, DeploySchema, DeploysFileSchema, InventorySchema, CanaryCheckSchema, ScenarioFileSchema,
  AfterFileSchema, ScenarioSummarySchema,
} from "./scenario.ts";
import { RangeSchema, MetricSourceSchema, IncidentMetricsSchema } from "./metrics.ts";
import { PostmortemDocSchema } from "./postmortem.ts";
import { AlertSchema, EscalationSchema, IncidentSchema, LlmCallRecordSchema, RunRecordSchema } from "./incident.ts";
import {
  WorldStateSchema, CanaryCheckResultSchema, VerificationSchema, HandoffRecordSchema, RunbookMatchSchema,
  BlackboardSchema, SupervisorDecisionSchema, ReactStepSchema, AuditorVerdictSchema, PostmortemNarrativeSchema,
  LimitsSchema,
} from "./blackboard.ts";
import {
  CreateIncidentBodySchema, ListIncidentsQuerySchema, TraceQuerySchema, PostmortemQuerySchema, ApprovalsQuerySchema,
  DecisionBodySchema, StatsWindowSchema, StatsQuerySchema, IncidentSummarySchema, IncidentViewSchema,
  AuditEntryViewSchema, StatsSchema, ErrorBodySchema, ProposeRemediationInputSchema, ProposeRemediationResultSchema,
} from "./api.ts";
import { DEMO_LABEL, RecordingBranchSchema, DemoRecordingSchema } from "./demo-recording.ts";

export {
  SeveritySchema, IncidentStatusSchema, PhaseSchema, AgentIdSchema, TierSchema, RootCauseCategorySchema,
  ConfidenceSchema, EscalationReasonSchema, ActionStatusSchema, ApprovalStatusSchema, TraceTypeSchema,
  ReadToolNameSchema, LlmErrorKindSchema,
  EvidenceSchema, DiagnosisSchema,
  PlanStepSchema, RemediationPlanSchema,
  DryRunResultSchema, GatedActionSchema,
  ApprovalSchema,
  AuditCheckSchema, AuditReviewSchema, AuditEventSchema, AuditEntrySchema,
  TraceEventSchema, TraceLlmSchema,
  MetricNameSchema, MetricWindowSchema, SeriesSegmentSchema, SeriesSpecSchema, SeriesPointSchema, SignalsFileSchema,
  LogLineSchema, DeploySchema, DeploysFileSchema, InventorySchema, CanaryCheckSchema, ScenarioFileSchema,
  AfterFileSchema, ScenarioSummarySchema,
  RangeSchema, MetricSourceSchema, IncidentMetricsSchema,
  PostmortemDocSchema,
  AlertSchema, EscalationSchema, IncidentSchema, LlmCallRecordSchema, RunRecordSchema,
  WorldStateSchema, CanaryCheckResultSchema, VerificationSchema, HandoffRecordSchema, RunbookMatchSchema,
  BlackboardSchema, SupervisorDecisionSchema, ReactStepSchema, AuditorVerdictSchema, PostmortemNarrativeSchema,
  LimitsSchema,
  CreateIncidentBodySchema, ListIncidentsQuerySchema, TraceQuerySchema, PostmortemQuerySchema, ApprovalsQuerySchema,
  DecisionBodySchema, StatsWindowSchema, StatsQuerySchema, IncidentSummarySchema, IncidentViewSchema,
  AuditEntryViewSchema, StatsSchema, ErrorBodySchema, ProposeRemediationInputSchema, ProposeRemediationResultSchema,
  DEMO_LABEL, RecordingBranchSchema, DemoRecordingSchema,
};

export type Severity = z.infer<typeof SeveritySchema>;
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;
export type Phase = z.infer<typeof PhaseSchema>;
export type AgentId = z.infer<typeof AgentIdSchema>;
export type Tier = z.infer<typeof TierSchema>;
export type RootCauseCategory = z.infer<typeof RootCauseCategorySchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;
export type EscalationReason = z.infer<typeof EscalationReasonSchema>;
export type ActionStatus = z.infer<typeof ActionStatusSchema>;
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
export type TraceType = z.infer<typeof TraceTypeSchema>;
export type ReadToolName = z.infer<typeof ReadToolNameSchema>;
export type LlmErrorKind = z.infer<typeof LlmErrorKindSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Diagnosis = z.infer<typeof DiagnosisSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type RemediationPlan = z.infer<typeof RemediationPlanSchema>;
export type DryRunResult = z.infer<typeof DryRunResultSchema>;
export type GatedAction = z.infer<typeof GatedActionSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type AuditCheck = z.infer<typeof AuditCheckSchema>;
export type AuditReview = z.infer<typeof AuditReviewSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export type TraceEvent = z.infer<typeof TraceEventSchema>;
export type TraceLlm = z.infer<typeof TraceLlmSchema>;
export type MetricName = z.infer<typeof MetricNameSchema>;
export type MetricWindow = z.infer<typeof MetricWindowSchema>;
export type SeriesSegment = z.infer<typeof SeriesSegmentSchema>;
export type SeriesSpec = z.infer<typeof SeriesSpecSchema>;
export type SeriesPoint = z.infer<typeof SeriesPointSchema>;
export type SignalsFile = z.infer<typeof SignalsFileSchema>;
export type LogLine = z.infer<typeof LogLineSchema>;
export type Deploy = z.infer<typeof DeploySchema>;
export type DeploysFile = z.infer<typeof DeploysFileSchema>;
export type Inventory = z.infer<typeof InventorySchema>;
export type CanaryCheck = z.infer<typeof CanaryCheckSchema>;
export type ScenarioFile = z.infer<typeof ScenarioFileSchema>;
export type AfterFile = z.infer<typeof AfterFileSchema>;
export type ScenarioSummary = z.infer<typeof ScenarioSummarySchema>;
export type Range = z.infer<typeof RangeSchema>;
export type MetricSource = z.infer<typeof MetricSourceSchema>;
export type IncidentMetrics = z.infer<typeof IncidentMetricsSchema>;
export type PostmortemDoc = z.infer<typeof PostmortemDocSchema>;
export type Alert = z.infer<typeof AlertSchema>;
export type Escalation = z.infer<typeof EscalationSchema>;
export type Incident = z.infer<typeof IncidentSchema>;
export type NewIncident = Omit<Incident, "status" | "resolvedAt" | "escalation">;
export type LlmCallRecord = z.infer<typeof LlmCallRecordSchema>;
export type RunRecord = z.infer<typeof RunRecordSchema>;
export type WorldState = z.infer<typeof WorldStateSchema>;
export type CanaryCheckResult = z.infer<typeof CanaryCheckResultSchema>;
export type Verification = z.infer<typeof VerificationSchema>;
export type HandoffRecord = z.infer<typeof HandoffRecordSchema>;
export type RunbookMatch = z.infer<typeof RunbookMatchSchema>;
export type Blackboard = z.infer<typeof BlackboardSchema>;
export type SupervisorDecision = z.infer<typeof SupervisorDecisionSchema>;
export type ReactStep = z.infer<typeof ReactStepSchema>;
export type AuditorVerdict = z.infer<typeof AuditorVerdictSchema>;
export type PostmortemNarrative = z.infer<typeof PostmortemNarrativeSchema>;
export type Limits = z.infer<typeof LimitsSchema>;
export type CreateIncidentBody = z.infer<typeof CreateIncidentBodySchema>;
export type ListIncidentsQuery = z.infer<typeof ListIncidentsQuerySchema>;
export type TraceQuery = z.infer<typeof TraceQuerySchema>;
export type PostmortemQuery = z.infer<typeof PostmortemQuerySchema>;
export type ApprovalsQuery = z.infer<typeof ApprovalsQuerySchema>;
export type DecisionBody = z.infer<typeof DecisionBodySchema>;
export type StatsWindow = z.infer<typeof StatsWindowSchema>;
export type StatsQuery = z.infer<typeof StatsQuerySchema>;
export type IncidentSummary = z.infer<typeof IncidentSummarySchema>;
export type IncidentView = z.infer<typeof IncidentViewSchema>;
export type AuditEntryView = z.infer<typeof AuditEntryViewSchema>;
export type Stats = z.infer<typeof StatsSchema>;
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
export type ProposeRemediationInput = z.infer<typeof ProposeRemediationInputSchema>;
export type ProposeRemediationResult = z.infer<typeof ProposeRemediationResultSchema>;
export type RecordingBranch = z.infer<typeof RecordingBranchSchema>;
export type DemoRecording = z.infer<typeof DemoRecordingSchema>;

/** Tetos padrão do spec 6.2. */
export const DEFAULT_LIMITS: Limits = Object.freeze({
  reactMaxSteps: 12, maxTelemetryRuns: 2, teamMaxIterations: 8, recursionLimit: 25, maxPlanRevisions: 2,
});
