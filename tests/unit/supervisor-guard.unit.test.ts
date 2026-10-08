import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalNext, guardChoice, preEscalation } from "../../src/domain/supervisor/supervisor-guard.ts";
import { L, act, audit, bb, esc, healthy, high, low, medium, planOf } from "../helpers/blackboard.ts";

const pick = (g: { next: string; coerced: boolean }) => ({ next: g.next, coerced: g.coerced });

test("gate without plan is coerced to the canonical route", () => {
  assert.deepEqual(pick(guardChoice("gate", bb({ diagnosis: high() }), L)), { next: "runbook_retriever", coerced: true });
  assert.match(guardChoice("gate", bb({ diagnosis: high() }), L).reason, /no plan/);
});

test("runbook_retriever does not repeat", () => {
  assert.equal(guardChoice("runbook_retriever", bb({ diagnosis: high(), runbookSearchDone: true }), L).coerced, true);
  assert.equal(guardChoice("runbook_retriever", bb({ diagnosis: medium() }), L).coerced, false);
  assert.equal(guardChoice("runbook_retriever", bb({ diagnosis: low(), telemetryRuns: 1 }), L).coerced, true);
});

test("telemetry again only for low confidence under 2 runs", () => {
  assert.equal(guardChoice("telemetry_analyst", bb({ diagnosis: low(), telemetryRuns: 1 }), L).coerced, false);
  assert.equal(guardChoice("telemetry_analyst", bb({ diagnosis: high(), telemetryRuns: 1 }), L).coerced, true);
  assert.equal(guardChoice("telemetry_analyst", bb(), L).coerced, false);
  assert.equal(guardChoice("telemetry_analyst", bb({ diagnosis: { ...low(), capReached: true }, telemetryRuns: 1 }), L).coerced, true);
});

test("planner needs medium or high confidence, runbook search done and no plan", () => {
  assert.equal(guardChoice("remediation_planner", bb({ diagnosis: high(), runbookSearchDone: true }), L).coerced, false);
  assert.equal(guardChoice("remediation_planner", bb({ diagnosis: high(), runbookSearchDone: false }), L).coerced, true);
  assert.equal(guardChoice("remediation_planner", bb({ diagnosis: high(), runbookSearchDone: true, plan: planOf() }), L).coerced, true);
  assert.equal(guardChoice("remediation_planner", bb({ diagnosis: low(), telemetryRuns: 1, runbookSearchDone: true }), L).coerced, true);
});

test("gate needs plan, audit and no actions", () => {
  const ready = { diagnosis: high(), runbookSearchDone: true, plan: planOf(), audit: audit("approve") };
  assert.deepEqual(pick(guardChoice("gate", bb(ready), L)), { next: "gate", coerced: false });
  assert.equal(guardChoice("gate", bb({ ...ready, actions: [act("ready")] }), L).coerced, true);
  assert.equal(guardChoice("gate", bb({ ...ready, audit: null }), L).coerced, true);
});

test("done becomes reporter, valid only when verified or escalated", () => {
  assert.deepEqual(pick(guardChoice("done", bb({ verification: healthy() }), L)), { next: "reporter", coerced: false });
  assert.deepEqual(pick(guardChoice("reporter", bb({ escalation: esc() }), L)), { next: "reporter", coerced: false });
  assert.equal(guardChoice("done", bb({ diagnosis: null }), L).next, "telemetry_analyst");
  assert.equal(guardChoice("reporter", bb({ diagnosis: null }), L).coerced, true);
});

test("canonical route follows diagnosis, runbooks, audited plan, gate, report", () => {
  assert.equal(canonicalNext(bb(), L), "telemetry_analyst");
  assert.equal(canonicalNext(bb({ diagnosis: low(), telemetryRuns: 1 }), L), "telemetry_analyst");
  assert.equal(canonicalNext(bb({ diagnosis: high() }), L), "runbook_retriever");
  assert.equal(canonicalNext(bb({ diagnosis: high(), runbookSearchDone: true }), L), "remediation_planner");
  assert.equal(canonicalNext(bb({ diagnosis: high(), runbookSearchDone: true, plan: planOf(), audit: audit("approve") }), L), "gate");
  assert.equal(canonicalNext(bb({ diagnosis: high(), runbookSearchDone: true, plan: planOf(), audit: audit("approve"), actions: [act("succeeded")], verification: healthy() }), L), "reporter");
});

test("preEscalation order: team cap, react cap, low confidence after 2 runs", () => {
  assert.equal(preEscalation(bb({ supervisor: { iterations: 9, history: [] } }), L)!.reason, "team_cap_reached");
  assert.equal(preEscalation(bb({ supervisor: { iterations: 8, history: [] } }), L), null);
  assert.equal(preEscalation(bb({ diagnosis: { ...low(), capReached: true } }), L)!.reason, "react_cap_low_confidence");
  assert.equal(preEscalation(bb({ diagnosis: low(), telemetryRuns: 2 }), L)!.reason, "low_confidence_diagnosis");
  assert.equal(preEscalation(bb({ diagnosis: low(), telemetryRuns: 1 }), L), null);
  // A ordem importa: o teto de equipe vence os demais.
  assert.equal(preEscalation(bb({ supervisor: { iterations: 9, history: [] }, diagnosis: { ...low(), capReached: true }, telemetryRuns: 2 }), L)!.reason, "team_cap_reached");
});
