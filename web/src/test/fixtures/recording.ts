// Gravação mínima escrita à mão para os testes da War Room: 3 eventos comuns (até o portão) e 2 por ramo. Passa no
// DemoRecordingSchema (conferido em demo-source.test.ts). Dados próprios, não copiados das fixtures do backend.
import type { Approval, AuditEntryView, DemoRecording, GatedAction, IncidentMetrics, IncidentView, PostmortemDoc, TraceEvent } from "@contracts";
import { DEMO_LABEL } from "@contracts";

const base = { incidentId: "INC-0001", runId: "RUN-0001", requestId: null, llm: null } as const;
const ts = (s: string) => `2026-10-04T09:${s}.000Z`;

export const commonEvents: TraceEvent[] = [
  { ...base, id: "INC-0001:1", seq: 1, ts: ts("42:50"), agent: "supervisor", type: "handoff", payload: { from: "supervisor", to: "telemetry_analyst", brief: "Correlacione o pico de 5xx com o último deploy", reason: "Sem diagnóstico ainda" } },
  { ...base, id: "INC-0001:2", seq: 2, ts: ts("43:10"), agent: "telemetry_analyst", type: "thought", payload: { text: "Preciso medir o pico de erros desde o deploy" } },
  { ...base, id: "INC-0001:3", seq: 3, ts: ts("46:05"), agent: "gate", type: "handoff", payload: { from: "gate", to: "human", brief: "aguardando aprovação de APR-0001", reason: "1 passo de faixa 3 exige decisão humana" } },
];

const approvedEvents: TraceEvent[] = [
  { ...base, id: "INC-0001:4", seq: 4, ts: ts("49:05"), agent: "human", type: "handoff", payload: { from: "human", to: "executor", brief: "decisões registradas: 1 aprovada", reason: "todas as aprovações do lote foram decididas" } },
  { ...base, id: "INC-0001:5", seq: 5, ts: ts("51:41"), agent: "verifier", type: "critique", payload: { by: "canary", verdict: "approve", feedback: "canário saudável" } },
];

const rejectedEvents: TraceEvent[] = [
  { ...base, id: "INC-0001:4", seq: 4, ts: ts("49:05"), agent: "human", type: "handoff", payload: { from: "human", to: "executor", brief: "decisões registradas: 1 rejeitada", reason: "todas as aprovações do lote foram decididas" } },
  { ...base, id: "INC-0001:5", seq: 5, ts: ts("49:06"), agent: "system", type: "answer", payload: { kind: "escalation", text: "Incidente escalado para humanos: mitigation_rejected." } },
];

const action = (o: Partial<GatedAction> & Pick<GatedAction, "id" | "order" | "actionType" | "target" | "tier" | "status">): GatedAction => ({
  incidentId: "INC-0001", planRevision: 0, params: {}, dependsOn: [], classificationReasons: [`faixa do catálogo: ${o.tier}`],
  dryRun: null, approvalId: null, proposedBy: "remediation_planner", executedAt: null, resultSummary: null, ...o,
});

export const gateActions: GatedAction[] = [
  action({ id: "ACT-0001", order: 1, actionType: "add_incident_note", target: "incident/orders-api", tier: 2, status: "ready", params: { text: "rollback em avaliação" },
    dryRun: { ok: true, changes: ["incident/orders-api: nota registrada"], reversible: false, estimatedDurationSec: 1, failureReason: null } }),
  action({ id: "ACT-0002", order: 2, actionType: "rollback_deployment", target: "deployment/orders-api", tier: 3, status: "awaiting_approval", params: { toVersion: "v3.7.2" }, approvalId: "APR-0001",
    dryRun: { ok: true, changes: ["deployment/orders-api: v3.8.0 -> v3.7.2 (6 réplicas)"], reversible: true, estimatedDurationSec: 90, failureReason: null } }),
  action({ id: "ACT-0003", order: 3, actionType: "delete_backups", target: "backup_vault/orders-api", tier: 4, status: "blocked_forbidden", classificationReasons: ["proibida por construção (faixa 4)"] }),
];

const approval = (status: Approval["status"]): Approval => ({
  id: "APR-0001", incidentId: "INC-0001", actionId: "ACT-0002", status, requestedAt: ts("46:05"), expiresAt: "2026-10-04T10:16:05.000Z",
  decidedAt: status === "pending" ? null : ts("49:05"), approver: status === "pending" ? null : "operador demo", comment: null,
  decisionSource: status === "pending" ? null : "structured", version: status === "pending" ? 0 : 1,
});

export const metrics: IncidentMetrics = {
  impactStartedAt: ts("40:30"), detectedAt: ts("42:30"), resolvedAt: ts("51:41"),
  mttdMin: 2, mttrMin: 11.1833, timeAwaitingApprovalMin: 3,
  baselineMttrMin: { low: 45, high: 95 }, minutesSaved: { low: 33.8167, high: 83.8167 },
  impactFraction: 0.0912, revenuePerMinuteUsd: 150,
  downtimeCostAvoidedUsd: { low: 462.6, high: 1146.6 }, engineeringCostSavedUsd: { low: 101.45, high: 251.45 },
  monthlySavingsUsd: 0, llmCostUsd: 0, copilotCostUsd: 30, roiIllustrative: { low: 18.8, high: 46.9 },
  llmCalls: 11, promptTokens: 9000, completionTokens: 900, assumptionsVersion: "2026-10-04",
  sources: { mttrMin: "measured", timeAwaitingApprovalMin: "measured", baselineMttrMin: "assumption", minutesSaved: "derived", roiIllustrative: "derived", monthlySavingsUsd: "derived" },
};

const postmortem = (status: PostmortemDoc["status"]): PostmortemDoc => ({
  incidentId: "INC-0001", title: "Taxa de 5xx acima de 5% no orders-api", status,
  summary: status === "final" ? "Rollback aprovado devolveu o orders-api à versão estável." : "Incidente escalado: a mitigação foi rejeitada.",
  impact: { service: "orders-api", durationMin: status === "final" ? 11.2 : null, peakErrorRate: 0.1, monthlySavingsUsd: 0 },
  timeline: [{ ts: ts("42:30"), text: "alerta detectado" }, { ts: ts("49:05"), text: status === "final" ? "APR-0001 aprovada" : "APR-0001 rejeitada" }],
  rootCause: { category: "bad_deploy", narrative: "O deploy v3.8.0 introduziu erro de formatação de preço.", evidence: [{ source: "deploys", ref: "deploys:orders-api@09:40", summary: "v3.8.0 às 09:40" }] },
  actions: [{ actionType: "rollback_deployment", tier: 3, status: status === "final" ? "succeeded" : "rejected", decidedBy: "operador demo" }],
  metrics: status === "final" ? metrics : { ...metrics, resolvedAt: null, mttrMin: null, minutesSaved: null, roiIllustrative: null },
  prevention: ["Canário automático antes de promover a versão"],
  escalation: status === "final" ? null : { reason: "mitigation_rejected", detail: "rollback rejeitado pelo operador" },
  generatedBy: status === "final" ? { provider: "fake", model: "fake/scripted", promptVersion: "postmortem.v1" } : { provider: "fake", model: "template", promptVersion: "postmortem.v1" },
  numericGuard: { passed: status === "final", rejectedNumbers: [], usedTemplate: status !== "final" },
});

const view = (status: IncidentView["incident"]["status"], actions: GatedAction[], approvals: Approval[], o: Partial<IncidentView> = {}): IncidentView => ({
  incident: {
    id: "INC-0001", title: "Taxa de 5xx acima de 5% no orders-api", service: "orders-api", severity: "sev1", status, scenarioId: "deploy-5xx-rollback",
    openedAt: ts("42:30"), impactStartedAt: ts("40:30"), detectedAt: ts("42:30"), resolvedAt: status === "resolved" ? ts("51:41") : null,
    escalation: status === "escalated" ? { reason: "mitigation_rejected", detail: "rollback rejeitado pelo operador" } : null,
  },
  diagnosis: null, runbookMatches: [], plan: null, planRevision: 0, audit: null, actions, approvals, verification: null, metrics: null,
  postmortemReady: false, traceCount: 3, ...o,
});

const audit = (id: string, event: AuditEntryView["event"], actor: string, tier: AuditEntryView["tier"]): AuditEntryView => ({
  id, ts: ts("46:05"), actor, event, tier, details: {}, prevHash: "0".repeat(64), hash: id.replace("AUD-", "").padStart(64, "0"),
});

const done = (a: GatedAction, status: GatedAction["status"]): GatedAction => ({ ...a, status });

export const rec: DemoRecording = {
  schemaVersion: 1,
  label: DEMO_LABEL,
  recordedWith: { provider: "fake", promptVersions: ["supervisor.v1", "postmortem.v1"] },
  scenario: { id: "deploy-5xx-rollback", title: "Taxa de 5xx acima de 5% no orders-api", summary: "Deploy recente derruba o checkout", service: "orders-api", account: null, severity: "sev1" },
  common: {
    events: commonEvents,
    incident: view("awaiting_approval", gateActions, [approval("pending")]),
    approvals: [approval("pending")],
    audit: [audit("AUD-0001", "incident_opened", "system:incident-service", null), audit("AUD-0002", "approval_requested", "agent:gate", 3)],
    metrics: null,
    postmortem: null,
  },
  branches: {
    approved: {
      events: approvedEvents,
      incident: view("resolved", gateActions.map((a) => (a.tier === 4 ? a : done(a, "succeeded"))), [approval("approved")], { metrics, postmortemReady: true, traceCount: 5 }),
      approvals: [approval("approved")],
      audit: [audit("AUD-0003", "approval_approved", "human:operador demo", 3), audit("AUD-0004", "incident_resolved", "system:incident-service", null)],
      metrics,
      postmortem: postmortem("final"),
    },
    rejected: {
      events: rejectedEvents,
      incident: view("escalated", gateActions.map((a) => (a.tier === 3 ? done(a, "rejected") : a)), [approval("rejected")], { postmortemReady: true, traceCount: 5 }),
      approvals: [approval("rejected")],
      audit: [audit("AUD-0003", "approval_rejected", "human:operador demo", 3), audit("AUD-0004", "incident_escalated", "system:escalation", null)],
      metrics: null,
      postmortem: postmortem("partial"),
    },
  },
};
