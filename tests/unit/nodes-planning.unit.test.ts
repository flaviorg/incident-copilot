import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunbookQuery, createRunbooksNode } from "../../src/graph/nodes/runbooks-node.ts";
import { createPlannerNode } from "../../src/graph/nodes/planner-node.ts";
import { createAuditorNode } from "../../src/graph/nodes/auditor-node.ts";
import { catalogPromptText } from "../../src/domain/autonomy/catalog.ts";
import type { Blackboard } from "../../src/contracts/index.ts";
import type { Container } from "../../src/app/container.ts";
import { createTestContainer, incidentIdOf } from "../helpers/container.ts";
import { errTurn, patchFixture, readFixture } from "../helpers/fixtures.ts";
import {
  costDiagnosis, costStateWithPlan, deployDiagnosis, deployStateWithPlan, reviseAudit, tlsDiagnosis, withDiagnosis,
} from "../helpers/states.ts";

const rd = (c: Container) => ({ runbooks: c.runbooks, trace: c.trace });
const pd = (c: Container) => ({ llm: c.llm, trace: c.trace, catalogText: catalogPromptText });
const ad = (c: Container) => ({ llm: c.llm, trace: c.trace, scenarios: c.scenarios, limits: c.limits });

test("runbooks node ranks orders-5xx first for the deploy diagnosis", async () => {
  const c = createTestContainer();
  const bb = withDiagnosis(c, "deploy-5xx-rollback", deployDiagnosis());
  assert.equal(buildRunbookQuery(bb).service, "orders-api");
  const out = await createRunbooksNode(rd(c))(bb);
  assert.equal(out.runbookMatches![0]!.runbookId, "orders-5xx-after-deploy");
  assert.equal(out.runbookMatches![0]!.section, "mitigation");
  assert.ok(out.runbookMatches!.length <= 3);
  assert.ok(!out.runbookMatches!.some((m) => m.runbookId === "postgres-connection-exhaustion"));
  assert.equal(out.runbookSearchDone, true);
  assert.equal(out.phase, "planning");
  const trace = c.store.listTrace(bb.incidentId);
  assert.deepEqual(trace.map((e) => e.type), ["action", "observation", "handoff"]);
  assert.ok(trace[0]!.type === "action" && trace[0]!.payload.tool === "search_runbooks" && trace[0]!.payload.tier === 1);
  assert.match(c.store.listTrace(bb.incidentId, { type: "observation" })[0]!.payload.summary, /orders-5xx-after-deploy@[0-9a-f]{6} §mitigation \(normalized score 0\.\d\d\)/);
});

test("cost diagnosis finds the cloud cost runbook including its mitigation section", async () => {
  const c = createTestContainer();
  const out = await createRunbooksNode(rd(c))(withDiagnosis(c, "cost-anomaly", costDiagnosis()));
  assert.deepEqual(out.runbookMatches!.map((m) => `${m.runbookId}#${m.section}`), ["cloud-cost-anomaly#diagnosis", "cloud-cost-anomaly#mitigation"]);
});

test("runbooks node records a refusal when nothing passes the threshold", async () => {
  const c = createTestContainer();
  const out = await createRunbooksNode(rd(c))(withDiagnosis(c, "deploy-5xx-rollback", tlsDiagnosis(), { service: "billing-api", rule: "certificado tls expirado" }));
  assert.deepEqual(out.runbookMatches, []);
  assert.equal(out.runbookSearchDone, true);
  assert.match(c.store.listTrace(incidentIdOf(c), { type: "observation" }).at(-1)!.payload.summary, /refusal/);
});

test("planner produces revision 0 and then revision 1 with the auditor feedback", async () => {
  const c = createTestContainer();
  const planner = createPlannerNode(pd(c));
  const s0: Blackboard = { ...costStateWithPlan(c, 0), plan: null };
  const out0 = await planner(s0);
  assert.equal(out0.planRevision, 0);
  assert.equal(out0.audit, null);
  assert.equal(out0.plan!.steps.some((s) => s.actionType === "create_volume_snapshot"), false);
  const s1: Blackboard = { ...s0, ...out0, audit: reviseAudit("missing snapshot before delete_volume") };
  const out1 = await planner(s1);
  assert.equal(out1.planRevision, 1);
  assert.equal(out1.plan!.steps.some((s) => s.actionType === "create_volume_snapshot"), true);
  const calls = c.fake.calls().filter((x) => x.prompt === "planner.v1");
  assert.deepEqual(calls.map((x) => x.matchKeys), [{ revision: 0 }, { revision: 1 }]);
  assert.match(calls[1]!.user, /missing snapshot before delete_volume/);
  assert.match(calls[0]!.user, /rollback_deployment/); // o catálogo chega como texto
  const plans = c.store.listTrace(s0.incidentId, { type: "plan" });
  assert.deepEqual(plans.map((e) => e.payload.revision), [0, 1]);
  assert.deepEqual(c.store.listTrace(s0.incidentId, { type: "handoff" }).map((e) => `${e.payload.from}>${e.payload.to}`), ["remediation_planner>auditor", "remediation_planner>auditor"]);
});

test("auditor: rule failure plus LLM revise gives revise", async () => {
  const c = createTestContainer();
  const out = await createAuditorNode(ad(c))(costStateWithPlan(c, 0));
  assert.deepEqual([out.audit!.verdict, out.audit!.llmVerdict, out.audit!.overridden], ["revise", "revise", false]);
  assert.equal(out.audit!.checks.find((x) => !x.passed)!.rule, "snapshot_before_delete");
  const critique = c.store.listTrace(incidentIdOf(c), { type: "critique" }).at(-1)!;
  assert.deepEqual([critique.payload.by, critique.payload.verdict], ["auditor", "revise"]);
  assert.match(critique.payload.feedback, /failed rules: snapshot_before_delete/);
  assert.equal(c.store.listTrace(incidentIdOf(c), { type: "handoff" }).at(-1)!.payload.to, "remediation_planner");
});

test("auditor approves the deploy plan and hands back to the supervisor", async () => {
  const c = createTestContainer();
  const out = await createAuditorNode(ad(c))(deployStateWithPlan(c));
  assert.deepEqual([out.audit!.verdict, out.audit!.overridden], ["approve", false]);
  assert.ok(out.audit!.checks.every((x) => x.passed));
  assert.equal(c.store.listTrace(incidentIdOf(c), { type: "handoff" }).at(-1)!.payload.to, "supervisor");
});

test("auditor: LLM approve over a failing rule is overridden and recorded", async () => {
  const c = createTestContainer({ fixture: patchFixture(readFixture("fixtures/llm/cost-anomaly.json"), { replace: { "aud-0": { output: { verdict: "approve", feedback: "ok" } } } }) });
  const out = await createAuditorNode(ad(c))(costStateWithPlan(c, 0));
  assert.equal(out.audit!.verdict, "revise");
  assert.equal(out.audit!.overridden, true);
  assert.equal(out.audit!.llmVerdict, "approve");
  const cr = c.store.listTrace(incidentIdOf(c), { type: "critique" }).at(-1)!;
  assert.match(cr.payload.feedback, /overridden/);
  assert.equal(cr.type === "critique" && cr.payload.overridden, true, "the override is structured in the trace, so /stats can count it");
});

test("auditor without LLM falls back to the rules without escalating", async () => {
  const c = createTestContainer({
    fixture: patchFixture(readFixture("fixtures/llm/cost-anomaly.json"), { insertBefore: { "aud-0": [errTurn("e1", { revision: 0 }, "server_error"), errTurn("e2", { revision: 0 }, "timeout")] } }),
  });
  const out = await createAuditorNode(ad(c))(costStateWithPlan(c, 0));
  assert.deepEqual([out.audit!.verdict, out.audit!.llmVerdict, out.audit!.overridden], ["revise", null, false]);
  assert.equal(out.escalation, undefined);
  const ok = createTestContainer({
    fixture: patchFixture(readFixture("fixtures/llm/cost-anomaly.json"), { insertBefore: { "aud-1": [errTurn("e1", { revision: 1 }, "server_error"), errTurn("e2", { revision: 1 }, "server_error")] } }),
  });
  const passing = await createAuditorNode(ad(ok))(costStateWithPlan(ok, 1));
  assert.deepEqual([passing.audit!.verdict, passing.audit!.llmVerdict], ["approve", null]);
});
