import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../src/infra/db/sqlite.ts";
import { SqliteIncidentStore } from "../../src/infra/db/incident-store.ts";
import { ConflictError, NotFoundError } from "../../src/domain/errors.ts";
import type { Approval, Blackboard, GatedAction, IncidentStatus, LlmCallRecord, NewIncident, TraceEvent } from "../../src/contracts/index.ts";

const mk = () => new SqliteIncidentStore(openDatabase(":memory:"), { secrets: [], now: () => new Date("2026-10-04T10:00:00Z") });

const incident = (o: Partial<NewIncident> = {}): NewIncident => ({
  id: "INC-0001", title: "5xx no orders-api", service: "orders-api", severity: "sev1", scenarioId: "deploy-5xx-rollback",
  openedAt: "2026-10-04T09:42:30.000Z", impactStartedAt: "2026-10-04T09:40:30.000Z", detectedAt: "2026-10-04T09:42:30.000Z", ...o,
});

const bb = (): Blackboard => ({
  incidentId: "INC-0001", scenarioId: "deploy-5xx-rollback", runId: "RUN-0001", phase: "new", timeOffsetSec: 0,
  alert: { title: "5xx", service: "orders-api", account: null, signal: "http_5xx_rate", threshold: 0.05, rule: "5xx acima de 5%", detectedAt: "2026-10-04T09:42:30.000Z", severity: "sev1" },
  diagnosis: null, telemetryRuns: 0, runbookMatches: [], runbookSearchDone: false, plan: null, planRevision: 0, audit: null,
  actions: [], world: { deployments: {}, inventory: null, initialInventory: null, notes: [], tagsForReview: [], snapshots: [] },
  verification: null, metrics: null, postmortem: null, supervisor: { iterations: 0, history: [] }, escalation: null,
});

const event = (o: { seq: number; type?: "handoff" | "thought"; agent?: TraceEvent["agent"] }): TraceEvent => {
  const base = { id: `INC-0001:${o.seq}`, incidentId: "INC-0001", runId: "RUN-0001", requestId: null, seq: o.seq, ts: "2026-10-04T09:42:30.000Z", agent: o.agent ?? "supervisor", llm: null };
  return o.type === "handoff"
    ? { ...base, type: "handoff", payload: { from: "supervisor", to: "telemetry_analyst", brief: "b", reason: "r" } }
    : { ...base, type: "thought", payload: { text: "pensando" } };
};

const action = (o: Partial<GatedAction> = {}): GatedAction => ({
  id: "ACT-0001", incidentId: "INC-0001", planRevision: 0, order: 1, actionType: "rollback_deployment", target: "deployment/orders-api",
  params: { toVersion: "v3.7.2" }, dependsOn: [], tier: 3, classificationReasons: ["catálogo: faixa 3"], status: "proposed",
  dryRun: null, approvalId: null, proposedBy: "remediation_planner", executedAt: null, resultSummary: null, ...o,
});

const approval = (o: Partial<Approval> = {}): Approval => ({
  id: "APR-0001", incidentId: "INC-0001", actionId: "ACT-0001", status: "pending", requestedAt: "2026-10-04T09:45:00.000Z",
  expiresAt: "2026-10-04T10:15:00.000Z", decidedAt: null, approver: null, comment: null, decisionSource: null, version: 0, ...o,
});

const llmCall = (o: Partial<LlmCallRecord> = {}): LlmCallRecord => ({
  incidentId: "INC-0001", runId: "RUN-0001", promptVersion: "supervisor.v1", model: "fake/scripted", promptTokens: 800,
  completionTokens: 60, costUsd: 0, latencyMs: 0, success: true, errorKind: null, ts: "2026-10-04T09:42:50.000Z", ...o,
});

test("incident roundtrip and SQL filters", () => {
  const s = mk();
  const created = s.createIncident(incident());
  assert.equal(created.status, "open"); assert.equal(created.resolvedAt, null); assert.equal(created.escalation, null);
  s.createIncident(incident({ id: "INC-0002", openedAt: "2026-10-04T09:50:00.000Z" }));
  s.createIncident(incident({ id: "INC-0003", service: "data-platform", openedAt: "2026-10-04T09:55:00.000Z" }));
  s.updateIncidentStatus("INC-0002", "escalated", { escalation: { reason: "mitigation_rejected", detail: "rejeitado" } });
  s.updateIncidentStatus("INC-0003", "resolved", { resolvedAt: "2026-10-04T10:05:00.000Z", mttrMin: 10 });
  assert.deepEqual(s.getIncident("INC-0002")!.escalation, { reason: "mitigation_rejected", detail: "rejeitado" });
  assert.equal(s.getIncident("INC-0003")!.resolvedAt, "2026-10-04T10:05:00.000Z");
  assert.equal(s.getIncident("INC-9999"), null);
  assert.equal(s.listIncidents({ status: "escalated", limit: 20 }).length, 1);
  assert.equal(s.listIncidents({ service: "orders-api", limit: 20 }).length, 2);
  assert.equal(s.listIncidents({ limit: 1 }).length, 1);
  assert.deepEqual(s.listIncidents({ limit: 20 }).map((i) => i.id), ["INC-0003", "INC-0002", "INC-0001"]);
  const summary = s.listIncidents({ status: "resolved" as IncidentStatus, limit: 5 })[0]!;
  assert.equal(summary.mttrMin, 10); assert.equal(summary.escalationReason, null);
  assert.throws(() => s.updateIncidentStatus("INC-9999", "open", {}), NotFoundError);
});

test("optimistic blackboard version", () => {
  const s = mk(); s.createIncident(incident());
  assert.equal(s.saveBlackboard("INC-0001", bb(), 0), 1);
  assert.throws(() => s.saveBlackboard("INC-0001", bb(), 0), (e) => e instanceof ConflictError && e.code === "version_conflict");
  assert.equal(s.loadBlackboard("INC-0001").version, 1);
  assert.equal(s.saveBlackboard("INC-0001", { ...bb(), phase: "investigating" }, 1), 2);
  assert.deepEqual(s.loadBlackboard("INC-0001"), { blackboard: { ...bb(), phase: "investigating" }, version: 2 });
  assert.throws(() => s.loadBlackboard("INC-0404"), NotFoundError);
});

test("trace order, filters, last N and unique seq", () => {
  const s = mk(); s.createIncident(incident());
  assert.equal(s.nextTraceSeq("INC-0001"), 1);
  s.appendTrace([event({ seq: 1, type: "handoff" }), event({ seq: 2 }), event({ seq: 3, type: "handoff" }), event({ seq: 4, agent: "telemetry_analyst" })]);
  assert.deepEqual(s.listTrace("INC-0001").map((e) => e.seq), [1, 2, 3, 4]);
  assert.equal(s.listTrace("INC-0001", { type: "handoff" }).length, 2);
  assert.equal(s.listTrace("INC-0001", { agent: "telemetry_analyst" }).length, 1);
  assert.deepEqual(s.listTrace("INC-0001", { last: 2 }).map((e) => e.seq), [3, 4]);
  assert.deepEqual(s.listTrace("INC-0001", { limit: 2 }).map((e) => e.seq), [1, 2]);
  // Conjunto de tipos em SQL (get_incident do MCP), combinável com last.
  assert.deepEqual(s.listTrace("INC-0001", { types: ["handoff"], last: 1 }).map((e) => e.seq), [3]);
  assert.deepEqual(s.listTrace("INC-0001", { types: ["thought"] }).map((e) => e.seq), [2, 4]);
  assert.deepEqual(s.listTrace("INC-0001", { types: ["handoff", "thought"] }).map((e) => e.seq), [1, 2, 3, 4]);
  assert.deepEqual(s.listTrace("INC-0001", { types: [] }).length, 0);
  assert.deepEqual(s.listTrace("INC-0001", { last: 0 }).length, 0);
  assert.equal(s.nextTraceSeq("INC-0001"), 5);
  assert.throws(() => s.appendTrace([event({ seq: 2 })]));
});

test("actions upsert and approvals with version check", () => {
  const s = mk(); s.createIncident(incident());
  s.upsertAction(action({ status: "awaiting_approval" })); s.upsertAction(action({ status: "approved" }));
  assert.equal(s.listActions("INC-0001").length, 1);
  assert.equal(s.listActions("INC-0001")[0]!.status, "approved");
  s.createApproval(approval({ version: 0 }));
  s.transitionApproval("APR-0001", approval({ status: "approved", version: 1, decidedAt: "2026-10-04T09:48:00.000Z", approver: "ana", decisionSource: "structured" }), 0);
  assert.throws(() => s.transitionApproval("APR-0001", approval({ status: "rejected", version: 2 }), 0), ConflictError);
  assert.equal(s.listApprovals({ status: "approved" }).length, 1);
  assert.equal(s.listApprovals({ incidentId: "INC-0001" }).length, 1);
  assert.equal(s.listApprovals({ status: "pending" }).length, 0);
  assert.equal(s.getApproval("APR-0001")!.approver, "ana");
  assert.equal(s.getApproval("APR-0001")!.version, 1);
  assert.equal(s.getApproval("APR-0404"), null);
});

test("llm calls and runs are persisted", () => {
  const s = mk(); s.createIncident(incident());
  s.recordLlmCall(llmCall()); s.recordLlmCall(llmCall({ success: false, errorKind: "timeout", promptVersion: "planner.v1" }));
  const calls = s.listLlmCalls("INC-0001");
  assert.equal(calls.length, 2); assert.equal(calls[1]!.errorKind, "timeout"); assert.equal(calls[1]!.success, false);
  s.recordRun({ id: "RUN-0001", incidentId: "INC-0001", startedAt: "2026-10-04T09:42:30.000Z", endedAt: null, outcome: null });
  s.recordRun({ id: "RUN-0001", incidentId: "INC-0001", startedAt: "2026-10-04T09:42:30.000Z", endedAt: "2026-10-04T09:46:00.000Z", outcome: "awaiting_approval" });
  assert.deepEqual(s.listRuns("INC-0001"), [{ id: "RUN-0001", incidentId: "INC-0001", startedAt: "2026-10-04T09:42:30.000Z", endedAt: "2026-10-04T09:46:00.000Z", outcome: "awaiting_approval" }]);
});
