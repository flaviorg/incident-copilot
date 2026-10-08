// /stats por SQL (spec 5.3; AC-33): percentis por posto mais próximo, janela, projeção da expiração e contadores.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../src/infra/db/sqlite.ts";
import { SqliteIncidentStore } from "../../src/infra/db/incident-store.ts";
import { SimulatedClock } from "../../src/infra/clock.ts";
import { StatsService, nearestRankOffset } from "../../src/app/stats-service.ts";
import type { GatedAction, TraceEvent } from "../../src/contracts/index.ts";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

function setup() {
  const db = openDatabase(":memory:");
  const clock = new SimulatedClock(NOW);
  const store = new SqliteIncidentStore(db, { secrets: [], now: () => clock.now() });
  let n = 0;
  const incident = (o: { openedMinAgo: number; status?: "resolved" | "escalated"; mttrMin?: number }) => {
    const id = `INC-${String(++n).padStart(4, "0")}`;
    const at = ago(o.openedMinAgo);
    store.createIncident({ id, title: "t", service: "orders-api", severity: "sev1", scenarioId: "deploy-5xx-rollback", openedAt: at, impactStartedAt: at, detectedAt: at });
    if (o.status) store.updateIncidentStatus(id, o.status, { mttrMin: o.mttrMin ?? null, resolvedAt: o.status === "resolved" ? at : null });
    return id;
  };
  return { db, clock, store, incident, stats: () => new StatsService({ db, clock }) };
}

const action = (id: string, incidentId: string, tier: 2 | 3 | 4, status: GatedAction["status"]): GatedAction => ({
  id, incidentId, planRevision: 0, order: 1, actionType: "add_incident_note", target: "incident/orders-api", params: {}, dependsOn: [],
  tier, classificationReasons: [], status, dryRun: null, approvalId: null, proposedBy: "remediation_planner", executedAt: null, resultSummary: null,
});

test("nearest-rank percentiles in SQL", () => {
  const { incident, stats } = setup();
  for (const m of [40, 10, 30, 20]) incident({ openedMinAgo: 30, status: "resolved", mttrMin: m });
  incident({ openedMinAgo: 30, status: "escalated" }); // escalado não entra no MTTR
  assert.deepEqual(stats().get("24h").mttrMin, { p50: 20, p95: 40 });
  assert.equal(nearestRankOffset(4, 0.5), 1);
  assert.equal(nearestRankOffset(4, 0.95), 3);
  assert.equal(nearestRankOffset(1, 0.95), 0);
  assert.equal(nearestRankOffset(20, 0.95), 18);
  assert.equal(nearestRankOffset(100, 0.95), 94);
  assert.equal(nearestRankOffset(0, 0.5), 0);
});

test("empty database: zeros, exhaustive keys and null percentiles", () => {
  const s = setup().stats().get("24h");
  assert.equal(s.window, "24h");
  assert.deepEqual(s.mttrMin, { p50: null, p95: null });
  assert.equal(s.incidents.total, 0);
  assert.deepEqual(Object.values(s.incidents.byStatus), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(s.actions.byTier, { "1": 0, "2": 0, "3": 0, "4": 0 });
  assert.equal(Object.keys(s.actions.byStatus).length, 16);
  assert.deepEqual(s.approvals, { pending: 0, approved: 0, rejected: 0, expired: 0 });
  assert.deepEqual(s.llm, { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 });
});

test("window filters by time and approvals project expiry without writing", () => {
  const { store, clock, incident, stats } = setup();
  const recent = incident({ openedMinAgo: 30, status: "resolved", mttrMin: 12 });
  incident({ openedMinAgo: 2 * 24 * 60, status: "resolved", mttrMin: 99 }); // fora de 24h, dentro de 7d
  store.upsertAction(action("ACT-0001", recent, 2, "succeeded"));
  store.upsertAction(action("ACT-0002", recent, 3, "approved"));
  store.upsertAction(action("ACT-0003", recent, 4, "blocked_forbidden"));
  const approval = { incidentId: recent, actionId: "ACT-0002", decidedAt: null, approver: null, comment: null, decisionSource: null, version: 0 } as const;
  store.createApproval({ ...approval, id: "APR-0001", status: "pending", requestedAt: ago(40), expiresAt: ago(10) }); // vencida
  store.createApproval({ ...approval, id: "APR-0002", status: "pending", requestedAt: ago(5), expiresAt: ago(-25) });
  store.createApproval({ ...approval, id: "APR-0003", status: "approved", requestedAt: ago(5), expiresAt: ago(-25) });
  store.recordLlmCall({ incidentId: recent, runId: "RUN-0001", promptVersion: "supervisor.v1", model: "m", promptTokens: 100, completionTokens: 20, costUsd: 0.0015, latencyMs: 5, success: true, errorKind: null, ts: ago(20) });
  store.recordLlmCall({ incidentId: recent, runId: "RUN-0001", promptVersion: "supervisor.v1", model: "m", promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 5, success: false, errorKind: "timeout", ts: ago(19) });
  store.recordLlmCall({ incidentId: recent, runId: "RUN-0001", promptVersion: "supervisor.v1", model: "m", promptTokens: 7, completionTokens: 7, costUsd: 1, latencyMs: 5, success: true, errorKind: null, ts: ago(3 * 24 * 60) });

  const day = stats().get("24h");
  assert.equal(day.incidents.total, 1);
  assert.equal(day.incidents.byStatus.resolved, 1);
  assert.deepEqual(day.mttrMin, { p50: 12, p95: 12 });
  assert.deepEqual(day.actions.byTier, { "1": 0, "2": 1, "3": 1, "4": 1 });
  assert.equal(day.actions.byStatus.blocked_forbidden, 1);
  assert.deepEqual(day.approvals, { pending: 1, approved: 1, rejected: 0, expired: 1 });
  assert.equal(store.getApproval("APR-0001")!.status, "pending");
  assert.deepEqual(day.llm, { calls: 2, errors: 1, promptTokens: 100, completionTokens: 20, estimatedCostUsd: 0.0015 });

  const week = stats().get("7d");
  assert.equal(week.incidents.total, 2);
  assert.deepEqual(week.mttrMin, { p50: 12, p95: 99 });
  assert.equal(week.llm.calls, 3);
  assert.equal(stats().get("1h").incidents.total, 1);
  clock.tick(2 * 3600);
  assert.equal(stats().get("1h").incidents.total, 0);
});

test("guard counters come from trace critiques", () => {
  const { store, incident, stats } = setup();
  const id = incident({ openedMinAgo: 10 });
  let seq = 0;
  const critique = (by: "supervisor_guard" | "auditor" | "numeric_guard" | "gate", verdict: "coerced" | "revise" | "reject" | "blocked", feedback: string, overridden?: boolean): TraceEvent => {
    seq += 1;
    const payload = overridden === undefined ? { by, verdict, feedback } : { by, verdict, feedback, overridden };
    return { id: `${id}:${seq}`, incidentId: id, runId: "RUN-0001", requestId: null, seq, ts: ago(5), agent: "system", llm: null, type: "critique", payload };
  };
  store.appendTrace([
    critique("supervisor_guard", "coerced", "gate without a plan"),
    critique("supervisor_guard", "coerced", "gate without a plan again"),
    // O contador lê o campo estruturado, não o texto: o feedback vem do modelo e pode ter qualquer palavra.
    critique("auditor", "revise", "rules: snapshot_before_delete", true),
    critique("auditor", "revise", "x".repeat(600), true), // feedback cortado em 600: nenhum marcador de texto sobrevive
    critique("auditor", "revise", "the model wrote that the previous plan was overridden", false),
    critique("auditor", "revise", "missing snapshot", false),
    critique("numeric_guard", "reject", "numbers without a source: 20%"),
    critique("gate", "blocked", "delete_backups"),
  ]);
  assert.deepEqual(stats().get("24h").guard, { supervisorCoercions: 2, auditorOverrides: 2, numericGuardRejections: 1 });
});
