import { test } from "node:test";
import assert from "node:assert/strict";
import { createReporterNode } from "../../src/graph/nodes/reporter-node.ts";
import { PostmortemDocSchema } from "../../src/contracts/index.ts";
import type { Container } from "../../src/app/container.ts";
import { createTestContainer, incidentIdOf } from "../helpers/container.ts";
import { errTurn, patchFixture, readFixture } from "../helpers/fixtures.ts";
import { escalatedState, verifiedDeployState } from "../helpers/states.ts";

const rpd = (c: Container) => ({
  llm: c.llm,
  providerName: c.config.llmProvider,
  trace: c.trace,
  clock: c.clock,
  scenarios: c.scenarios,
  assumptions: c.assumptions,
  read: {
    trace: (id: string) => c.store.listTrace(id),
    approvals: (id: string) => c.store.listApprovals({ incidentId: id }),
    llmCalls: (id: string) => c.store.listLlmCalls(id),
  },
  savingsFor: () => 0,
  isMitigating: (t: string) => t === "rollback_deployment",
});

test("invented number falls back to the template with a numeric_guard critique", async () => {
  const c = createTestContainer({ fixture: "tests/fixtures/llm/invented-numbers.json" });
  const out = await createReporterNode(rpd(c))(verifiedDeployState(c));
  assert.equal(out.postmortem!.numericGuard.usedTemplate, true);
  assert.equal(out.postmortem!.numericGuard.passed, false);
  assert.deepEqual(out.postmortem!.numericGuard.rejectedNumbers, ["20%"]);
  assert.equal(out.postmortem!.generatedBy.model, "template");
  assert.equal(out.postmortem!.status, "final");
  assert.doesNotMatch(out.postmortem!.summary, /20%/);
  const cr = c.store.listTrace(incidentIdOf(c), { type: "critique" }).at(-1)!;
  assert.deepEqual([cr.payload.by, cr.payload.verdict, cr.payload.feedback], ["numeric_guard", "reject", "numbers without a source: 20%"]);
});

test("valid narrative is kept", async () => {
  const c = createTestContainer();
  const out = await createReporterNode(rpd(c))(verifiedDeployState(c));
  const pm = out.postmortem!;
  assert.equal(PostmortemDocSchema.safeParse(pm).success, true);
  assert.deepEqual(pm.numericGuard, { passed: true, rejectedNumbers: [], usedTemplate: false });
  assert.deepEqual(pm.generatedBy, { provider: "fake", model: "fake/scripted", promptVersion: "postmortem.v1" });
  assert.equal(pm.status, "final");
  assert.match(pm.summary, /11\.2 min/);
  assert.equal(out.phase, "done");
  // Números calculados, não redigidos pelo LLM.
  assert.equal(out.metrics!.resolvedAt, "2026-10-04T09:51:41.000Z");
  assert.ok(Math.abs(out.metrics!.mttrMin! - 11.18) < 0.01);
  assert.equal(out.metrics!.timeAwaitingApprovalMin, 3);
  assert.ok(out.metrics!.impactFraction > 0.05);
  assert.deepEqual(pm.actions.map((a) => [a.actionType, a.tier, a.status, a.decidedBy]), [
    ["add_incident_note", 2, "succeeded", null], ["rollback_deployment", 3, "succeeded", "ana"], ["block_image_tag", 2, "succeeded", null],
  ]);
  // Linha do tempo determinística, em ordem, com aprovação e canário.
  assert.ok(pm.timeline.every((t, i) => i === 0 || t.ts >= pm.timeline[i - 1]!.ts));
  assert.ok(pm.timeline.some((t) => /APR-0001.*ana/.test(t.text)));
  assert.ok(pm.timeline.some((t) => /canary/.test(t.text)));
  assert.equal(pm.impact.peakErrorRate !== null && pm.impact.peakErrorRate > 0.09, true);
  const answer = c.store.listTrace(incidentIdOf(c), { type: "answer" }).at(-1)!;
  assert.deepEqual([answer.agent, answer.payload.kind, answer.payload.text], ["reporter", "postmortem", pm.summary]);
});

test("LLM failure uses the template without escalating", async () => {
  const fixture = patchFixture(readFixture("fixtures/llm/deploy-5xx-rollback.json"), {
    insertBefore: { "pm-1": [errTurn("e1", { kind: "final" }, "server_error"), errTurn("e2", { kind: "final" }, "invalid_output")] },
  });
  const c = createTestContainer({ fixture });
  const out = await createReporterNode(rpd(c))(verifiedDeployState(c));
  assert.equal(out.postmortem!.numericGuard.usedTemplate, true);
  assert.equal(out.postmortem!.generatedBy.model, "template");
  assert.equal(out.postmortem!.status, "final");
  assert.equal(out.escalation, undefined);
  assert.equal(out.phase, "done");
});

test("escalated incident gets a partial report without calling the LLM", async () => {
  const c = createTestContainer();
  const out = await createReporterNode(rpd(c))(escalatedState(c, "team_cap_reached"));
  assert.equal(out.postmortem!.status, "partial");
  assert.equal(c.fake.calls().filter((x) => x.prompt === "postmortem.v1").length, 0);
  assert.deepEqual(out.postmortem!.generatedBy, { provider: "fake", model: "template", promptVersion: "template" });
  assert.deepEqual(out.postmortem!.numericGuard, { passed: true, rejectedNumbers: [], usedTemplate: true });
  assert.deepEqual(out.postmortem!.escalation, { reason: "team_cap_reached", detail: "test: team_cap_reached" });
  assert.equal(out.metrics!.mttrMin, null);
  assert.match(out.postmortem!.summary, /escalated/);
});

test("LLM metrics include the post-mortem call itself", async () => {
  const c = createTestContainer();
  const out = await createReporterNode(rpd(c))(verifiedDeployState(c));
  const calls = c.store.listLlmCalls(incidentIdOf(c));
  assert.equal(calls.at(-1)!.promptVersion, "postmortem.v1", "the narrative call is recorded");
  const m = out.metrics!;
  assert.equal(m.llmCalls, calls.length);
  assert.equal(m.promptTokens, calls.reduce((s, x) => s + x.promptTokens, 0));
  assert.equal(m.completionTokens, calls.reduce((s, x) => s + x.completionTokens, 0));
  assert.deepEqual(out.postmortem!.metrics, m, "the post-mortem keeps the same metrics as the blackboard");
});
