// Blackboards e peças mínimas para testes de funções puras (guarda, status, roteamento).
import type {
  Approval, AuditReview, Blackboard, Diagnosis, Escalation, GatedAction, IncidentMetrics, PostmortemDoc, RemediationPlan, Verification,
} from "../../src/contracts/index.ts";
import { DEFAULT_LIMITS } from "../../src/contracts/index.ts";

export const L = DEFAULT_LIMITS;

export function bb(over: Partial<Blackboard> = {}): Blackboard {
  return {
    incidentId: "INC-0001",
    scenarioId: "deploy-5xx-rollback",
    runId: "RUN-0001",
    phase: "investigating",
    timeOffsetSec: 0,
    alert: {
      title: "5xx rate above 5% in orders-api", service: "orders-api", account: null, signal: "http_5xx_rate",
      threshold: 0.05, rule: "5xx above 5% for 2 min", detectedAt: "2026-10-04T09:42:30.000Z", severity: "sev1",
    },
    diagnosis: null,
    telemetryRuns: 0,
    runbookMatches: [],
    runbookSearchDone: false,
    plan: null,
    planRevision: 0,
    audit: null,
    actions: [],
    world: { deployments: {}, inventory: null, initialInventory: null, notes: [], tagsForReview: [], snapshots: [] },
    verification: null,
    metrics: null,
    postmortem: null,
    supervisor: { iterations: 0, history: [] },
    escalation: null,
    ...over,
  };
}

const diag = (confidence: Diagnosis["confidence"]): Diagnosis => ({
  hypothesis: "bad deploy", category: "bad_deploy", confidence, capReached: false,
  evidence: [{ source: "logs", ref: "logs:orders-api:ERROR@09:28-09:43", summary: "TypeError only in v3.8.0" }],
});
export const high = (): Diagnosis => diag("high");
export const medium = (): Diagnosis => diag("medium");
export const low = (): Diagnosis => diag("low");
export const healthy = (): Verification => ({ healthy: true, checks: [], revertedActionIds: [] });
export const esc = (reason: Escalation["reason"] = "team_cap_reached"): Escalation => ({ reason, detail: "teste" });
export const planOf = (): RemediationPlan => ({
  summary: "rollback",
  steps: [{ order: 1, actionType: "rollback_deployment", target: "deployment/orders-api", params: { toVersion: "v3.7.2" }, rationale: "r", runbookRef: null, dependsOn: [] }],
});
export const audit = (verdict: AuditReview["verdict"]): AuditReview => ({ verdict, feedback: "f", checks: [], llmVerdict: verdict, overridden: false });

export function act(status: GatedAction["status"], over: Partial<GatedAction> = {}): GatedAction {
  return {
    id: "ACT-0001", incidentId: "INC-0001", planRevision: 0, order: 1, actionType: "rollback_deployment", target: "deployment/orders-api",
    params: { toVersion: "v3.7.2" }, dependsOn: [], tier: 3, classificationReasons: [], status, dryRun: null, approvalId: null,
    proposedBy: "remediation_planner", executedAt: null, resultSummary: null, ...over,
  };
}

export function metricsStub(): IncidentMetrics {
  const r = { low: 0, high: 0 };
  return {
    impactStartedAt: "2026-10-04T09:40:30.000Z", detectedAt: "2026-10-04T09:42:30.000Z", resolvedAt: null, mttdMin: 2, mttrMin: null,
    timeAwaitingApprovalMin: 0, baselineMttrMin: { low: 45, high: 95 }, minutesSaved: null, impactFraction: 0, revenuePerMinuteUsd: 0,
    downtimeCostAvoidedUsd: r, engineeringCostSavedUsd: r, monthlySavingsUsd: 0, llmCostUsd: 0, copilotCostUsd: 30, roiIllustrative: null,
    llmCalls: 0, promptTokens: 0, completionTokens: 0, assumptionsVersion: "t", sources: {},
  };
}

export function pm(status: PostmortemDoc["status"]): PostmortemDoc {
  return {
    incidentId: "INC-0001", title: "t", status, summary: "s",
    impact: { service: "orders-api", durationMin: null, peakErrorRate: null, monthlySavingsUsd: 0 },
    timeline: [], rootCause: { category: "bad_deploy", narrative: "n", evidence: [] }, actions: [], metrics: metricsStub(), prevention: [],
    escalation: null, generatedBy: { provider: "fake", model: "template", promptVersion: "template" },
    numericGuard: { passed: true, rejectedNumbers: [], usedTemplate: true },
  };
}

export function pendingApproval(over: Partial<Approval> = {}): Approval {
  return {
    id: "APR-0001", incidentId: "INC-0001", actionId: "ACT-0002", status: "pending", requestedAt: "2026-10-04T10:00:00.000Z",
    expiresAt: "2026-10-04T10:30:00.000Z", decidedAt: null, approver: null, comment: null, decisionSource: null, version: 0, ...over,
  };
}
