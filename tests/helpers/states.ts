// Estados de cenário para testar nós isolados: o blackboard parte do incidente gravado e recebe os artefatos
// que os nós anteriores teriam produzido, tirados das próprias fixtures do fake.
import type { Container } from "../../src/app/container.ts";
import type { Alert, AuditReview, Blackboard, Diagnosis, Escalation, RemediationPlan } from "../../src/contracts/index.ts";
import { initialBlackboard } from "./container.ts";
import { readFixture } from "./fixtures.ts";

const FIXTURE: Record<string, string> = {
  "deploy-5xx-rollback": "fixtures/llm/deploy-5xx-rollback.json",
  "cost-anomaly": "fixtures/llm/cost-anomaly.json",
};

export function turnOutput<T>(scenarioId: string, turnId: string): T {
  const t = readFixture(FIXTURE[scenarioId]!).turns.find((x) => x.id === turnId);
  if (!t || t.output === undefined) throw new Error(`turn ${turnId} has no output in the ${scenarioId} fixture`);
  return structuredClone(t.output) as T;
}

/** Diagnóstico final roteirizado do analista (tel-4 no deploy, tel-3 no custo). */
export function scenarioDiagnosis(scenarioId: string): Diagnosis {
  const id = scenarioId === "cost-anomaly" ? "tel-3" : "tel-4";
  return { ...turnOutput<{ diagnosis: Omit<Diagnosis, "capReached"> }>(scenarioId, id).diagnosis, capReached: false };
}
export const deployDiagnosis = () => scenarioDiagnosis("deploy-5xx-rollback");
export const costDiagnosis = () => scenarioDiagnosis("cost-anomaly");

export function tlsDiagnosis(): Diagnosis {
  return {
    hypothesis: "The billing-api ingress TLS certificate expired and clients refuse the handshake",
    category: "config_error",
    confidence: "high",
    capReached: false,
    evidence: [{ source: "logs", ref: "logs:billing-api:ERROR@09:00-09:15", summary: "TLS handshake failed: certificate has expired" }],
  };
}

export function withDiagnosis(c: Container, scenarioId: string, diagnosis: Diagnosis, alert: Partial<Alert> = {}): Blackboard {
  const bb = initialBlackboard(c, scenarioId);
  return { ...bb, alert: { ...bb.alert, ...alert }, diagnosis, telemetryRuns: 1 };
}

export function planOfTurn(scenarioId: string, revision: number): RemediationPlan {
  return turnOutput<RemediationPlan>(scenarioId, `plan-${revision}`);
}

/** Estado do custo com diagnóstico, busca de runbooks feita e o plano da revisão pedida (sem auditoria). */
export function costStateWithPlan(c: Container, revision: number): Blackboard {
  const bb = withDiagnosis(c, "cost-anomaly", costDiagnosis());
  const runbookMatches = c.runbooks.search({ text: "cost idle volume snapshot", service: null });
  return { ...bb, runbookMatches, runbookSearchDone: true, plan: planOfTurn("cost-anomaly", revision), planRevision: revision, audit: null, phase: "planning" };
}

export function deployStateWithPlan(c: Container): Blackboard {
  const bb = withDiagnosis(c, "deploy-5xx-rollback", deployDiagnosis());
  const runbookMatches = c.runbooks.search({ text: "rollback previous version deploy", service: "orders-api" });
  return { ...bb, runbookMatches, runbookSearchDone: true, plan: planOfTurn("deploy-5xx-rollback", 0), planRevision: 0, audit: null, phase: "planning" };
}

export function reviseAudit(feedback: string): AuditReview {
  return { verdict: "revise", feedback, checks: [], llmVerdict: "revise", overridden: false };
}

export function escalatedState(c: Container, reason: Escalation["reason"]): Blackboard {
  return { ...withDiagnosis(c, "deploy-5xx-rollback", deployDiagnosis()), escalation: { reason, detail: `test: ${reason}` }, phase: "reporting" };
}

const at = (hms: string) => `2026-10-04T${hms}.000Z`;

/**
 * Deploy depois do canário saudável, na linha do tempo do spec 10.3: aprovação pedida às 09:46:05 e decidida às 09:49:05,
 * execução das 3 ações, canário saudável às 09:51:41 e supervisor escolhendo o relator às 09:52:01.
 */
export function verifiedDeployState(c: Container): Blackboard {
  const bb = deployStateWithPlan(c);
  const plan = bb.plan!;
  const base = { incidentId: bb.incidentId, planRevision: 0, proposedBy: "remediation_planner" as const, classificationReasons: [], dryRun: null };
  const actions: Blackboard["actions"] = [
    { ...base, id: "ACT-0001", order: 1, actionType: "add_incident_note", target: plan.steps[0]!.target, params: plan.steps[0]!.params, dependsOn: [], tier: 2, status: "succeeded", approvalId: null, executedAt: at("09:49:05"), resultSummary: "note recorded" },
    { ...base, id: "ACT-0002", order: 2, actionType: "rollback_deployment", target: "deployment/orders-api", params: { toVersion: "v3.7.2" }, dependsOn: [], tier: 3, status: "succeeded", approvalId: "APR-0001", executedAt: at("09:49:06"), resultSummary: "deployment/orders-api: v3.8.0 -> v3.7.2" },
    { ...base, id: "ACT-0003", order: 3, actionType: "block_image_tag", target: "image/orders-api:3.8.0", params: {}, dependsOn: [2], tier: 2, status: "succeeded", approvalId: null, executedAt: at("09:50:36"), resultSummary: "tag blocked" },
  ];
  c.store.createApproval({
    id: "APR-0001", incidentId: bb.incidentId, actionId: "ACT-0002", status: "approved", requestedAt: at("09:46:05"), expiresAt: at("10:16:05"),
    decidedAt: at("09:49:05"), approver: "ana", comment: null, decisionSource: "structured", version: 1,
  });
  c.clock.alignTo(new Date(at("09:51:41")));
  const ctx = { incidentId: bb.incidentId, runId: bb.runId, scenarioId: bb.scenarioId, requestId: null, signal: new AbortController().signal };
  c.trace.emit(ctx, "verifier", { type: "critique", payload: { by: "canary", verdict: "approve", feedback: "healthy canary: 5xx 0.5% ≤ 5%; P99 205 ms ≤ 270 ms" } });
  c.clock.alignTo(new Date(at("09:52:01")));
  return {
    ...bb,
    audit: { verdict: "approve", feedback: "ok", checks: [], llmVerdict: "approve", overridden: false },
    actions,
    verification: { healthy: true, checks: [{ metric: "http_5xx_rate", observed: 0.005, limit: 0.05, passed: true }, { metric: "p99_latency_ms", observed: 205, limit: 270, passed: true }], revertedActionIds: [] },
    phase: "reporting",
  };
}
