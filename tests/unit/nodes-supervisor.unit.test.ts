import { test } from "node:test";
import assert from "node:assert/strict";
import { createSupervisorNode, supervisorTargetOf } from "../../src/graph/nodes/supervisor-node.ts";
import { createEscalationNode } from "../../src/graph/nodes/escalation-node.ts";
import type { Blackboard } from "../../src/contracts/index.ts";
import type { Container } from "../../src/app/container.ts";
import { createTestContainer, initialBlackboard } from "../helpers/container.ts";
import { errTurn, patchFixture, readFixture } from "../helpers/fixtures.ts";

const sd = (c: Container) => ({ llm: c.llm, trace: c.trace, limits: c.limits });
const ed = (c: Container) => ({ trace: c.trace, audit: (e: Parameters<Container["store"]["appendAudit"]>[0]) => c.store.appendAudit(e) });

test("records the decision as handoff and history", async () => {
  const c = createTestContainer();
  const bb0 = initialBlackboard(c, "deploy-5xx-rollback");
  const out = await createSupervisorNode(sd(c))(bb0);
  assert.equal(out.supervisor!.iterations, 1);
  assert.equal(supervisorTargetOf({ ...bb0, ...out } as Blackboard), "telemetry_analyst");
  assert.equal(out.phase, "investigating");
  const h = out.supervisor!.history.at(-1)!;
  assert.deepEqual([h.iteration, h.from, h.to, h.coerced], [1, "supervisor", "telemetry_analyst", false]);
  const handoff = c.store.listTrace(bb0.incidentId, { type: "handoff" })[0]!;
  assert.equal(handoff.payload.to, "telemetry_analyst");
  assert.equal(handoff.payload.brief, h.brief);
  assert.equal(handoff.llm?.promptVersion, "supervisor.v1");
  assert.equal(c.store.listTrace(bb0.incidentId, { type: "critique" }).length, 0);
});

test("invalid choice is coerced with a critique", async () => {
  const c = createTestContainer({ fixture: "tests/fixtures/llm/guard-coercion.json" });
  const bb0 = initialBlackboard(c, "deploy-5xx-rollback");
  const out = await createSupervisorNode(sd(c))(bb0);
  assert.equal(out.supervisor!.history.at(-1)!.to, "telemetry_analyst");
  assert.equal(out.supervisor!.history.at(-1)!.coerced, true);
  const critique = c.store.listTrace(bb0.incidentId, { type: "critique" })[0]!;
  assert.deepEqual([critique.payload.by, critique.payload.verdict], ["supervisor_guard", "coerced"]);
  assert.match(critique.payload.feedback, /^escolha gate recusada: .+; seguindo telemetry_analyst$/);
  assert.equal(c.store.listTrace(bb0.incidentId, { type: "handoff" })[0]!.payload.to, "telemetry_analyst");
});

test("team cap escalates without calling the LLM", async () => {
  const c = createTestContainer({ limits: { teamMaxIterations: 3 } });
  const out = await createSupervisorNode(sd(c))({ ...initialBlackboard(c, "deploy-5xx-rollback"), supervisor: { iterations: 3, history: [] } });
  assert.equal(out.escalation!.reason, "team_cap_reached");
  assert.equal(out.supervisor!.iterations, 4);
  assert.equal(c.fake.calls().length, 0);
});

test("LLM failure escalates as llm_unavailable", async () => {
  const fixture = patchFixture(readFixture("fixtures/llm/deploy-5xx-rollback.json"), {
    insertBefore: { "sup-1": [errTurn("e1", { hasDiagnosis: false }, "server_error"), errTurn("e2", { hasDiagnosis: false }, "server_error")] },
  });
  const c = createTestContainer({ fixture });
  const bb0 = initialBlackboard(c, "deploy-5xx-rollback");
  const out = await createSupervisorNode(sd(c))(bb0);
  assert.equal(out.escalation!.reason, "llm_unavailable");
  assert.deepEqual(c.fake.consumedIds(), ["e1", "e2"]);
  assert.equal(c.store.listTrace(bb0.incidentId).length, 0);
});

test("escalation node writes a system answer and an audit row", async () => {
  const c = createTestContainer();
  const bb = { ...initialBlackboard(c, "deploy-5xx-rollback"), escalation: { reason: "team_cap_reached" as const, detail: "teto" } };
  const out = await createEscalationNode(ed(c))(bb as Blackboard, { configurable: { requestId: "req-9" } });
  assert.equal(out.phase, "reporting");
  const answer = c.store.listTrace(bb.incidentId, { type: "answer" })[0]!;
  assert.deepEqual([answer.agent, answer.payload.kind], ["system", "escalation"]);
  const row = c.store.listAudit(bb.incidentId).at(-1)!;
  assert.deepEqual([row.event, row.actor, row.details.reason, row.details.detail, row.details.requestId], ["incident_escalated", "system:escalation", "team_cap_reached", "teto", "req-9"]);
});

test("escalation node without a reason records no_executable_actions (gate with nothing to run)", async () => {
  const c = createTestContainer();
  const bb = initialBlackboard(c, "deploy-5xx-rollback");
  const out = await createEscalationNode(ed(c))(bb);
  assert.equal(out.escalation!.reason, "no_executable_actions");
  assert.equal(c.store.listAudit(bb.incidentId).at(-1)!.details.reason, "no_executable_actions");
});
