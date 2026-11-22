// Shared enums (spec 5.2). Browser-safe: only imports zod.
import * as z from "zod";

export const SeveritySchema = z.enum(["sev1", "sev2", "sev3"]);
export const IncidentStatusSchema = z.enum(["open", "investigating", "awaiting_approval", "mitigating", "resolved", "escalated", "advised"]);
export const PhaseSchema = z.enum(["new", "investigating", "planning", "gating", "awaiting_approval", "resume", "executing", "verifying", "reporting", "done"]);
export const AgentIdSchema = z.enum(["supervisor", "telemetry_analyst", "runbook_retriever", "remediation_planner", "auditor", "gate", "executor", "verifier", "reporter", "human", "system", "mcp_client", "code_fixer"]);
export const TierSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export const RootCauseCategorySchema = z.enum(["bad_deploy", "resource_leak", "capacity", "cost_anomaly", "vulnerability", "dependency_failure", "config_error", "unknown"]);
export const ConfidenceSchema = z.enum(["low", "medium", "high"]);
export const EscalationReasonSchema = z.enum([
  "team_cap_reached", "react_cap_low_confidence", "low_confidence_diagnosis", "recursion_limit", "llm_unavailable", "timeout",
  "mitigation_rejected", "remediation_ineffective", "throttled", "circuit_open", "no_executable_actions",
]);
export const ActionStatusSchema = z.enum([
  "proposed", "blocked_forbidden", "blocked_unknown", "rejected_invalid_params", "rejected_by_dry_run",
  "awaiting_approval", "approved", "rejected", "expired", "ready", "succeeded", "failed",
  "throttled", "blocked_circuit_open", "cancelled", "reverted", "recommended",
]);
export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected", "expired"]);
export const TraceTypeSchema = z.enum(["thought", "action", "observation", "plan", "critique", "answer", "handoff"]);
export const ReadToolNameSchema = z.enum(["query_metrics", "query_logs", "list_deploys", "audit_cloud_inventory", "query_errors", "query_external"]);
// LLM error kinds (spec 4.3, LlmError.kind); also used in llm_calls.error_kind.
export const LlmErrorKindSchema = z.enum(["timeout", "rate_limit", "server_error", "invalid_output", "aborted"]);
