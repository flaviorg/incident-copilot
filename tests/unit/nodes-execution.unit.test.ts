import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateNode } from "../../src/graph/nodes/gate-node.ts";
import { createExecutorNode, executorEscalationReason } from "../../src/graph/nodes/executor-node.ts";
import { createVerifierNode } from "../../src/graph/nodes/verifier-node.ts";
import type { ExecutionGuards } from "../../src/graph/nodes/executor-node.ts";
import { CircuitBreaker } from "../../src/domain/guards/circuit-breaker.ts";
import { ActionRateLimiter } from "../../src/domain/guards/action-rate-limiter.ts";
import type { ActionStatus, Blackboard } from "../../src/contracts/index.ts";
import type { Container } from "../../src/app/container.ts";
import type { LoadedScenario } from "../../src/infra/scenarios/scenario-loader.ts";
import { act } from "../helpers/blackboard.ts";
import { stateAtGate } from "../helpers/container.ts";
import type { TestContainerOptions } from "../helpers/container.ts";

const persistOf = (c: Container) => ({ action: c.store.upsertAction.bind(c.store), approval: c.store.createApproval.bind(c.store), audit: c.store.appendAudit.bind(c.store) });
const guards = (o: Partial<ExecutionGuards> = {}): ExecutionGuards => ({
  breaker: new CircuitBreaker({ failureThreshold: 3, cooldownSec: 300 }),
  limiter: new ActionRateLimiter({ perMinute: 5, repeatWindowMin: 10 }),
  ...o,
});
const ed = (c: Container, g: ExecutionGuards) => ({ infra: c.infra, scenarios: c.scenarios, guards: g, trace: c.trace, clock: c.clock, persist: persistOf(c) });

/** Deploy depois do portão e das decisões: status por ordem do passo, fase de retomada. */
async function decided(statuses: Partial<Record<number, ActionStatus>>, o: TestContainerOptions = {}): Promise<{ c: Container; bb: Blackboard }> {
  const { c, bb } = await stateAtGate("deploy-5xx-rollback", o);
  const out = await createGateNode({ infra: c.infra, trace: c.trace, clock: c.clock, ids: c.ids, approvalTtlMin: 30, persist: persistOf(c) })(bb);
  c.clock.tick(180);
  const actions = out.actions!.map((a) => (statuses[a.order] ? { ...a, status: statuses[a.order]! } : a));
  return { c, bb: { ...bb, actions, phase: "resume" } };
}

const events = (c: Container, id: string) => c.store.listAudit(id).map((e) => e.event);
const sinceGate = (c: Container, id: string) => events(c, id).slice(4); // incident_opened + 3 do portão

const badCanary = (s: LoadedScenario): LoadedScenario => {
  if (!s.after) return s;
  const constant = (value: number) => ({ segments: [{ fromSec: 0, toSec: 60, kind: "constant" as const, value }] });
  const variants = s.after.variants.map((v, i) => (i === 0 ? { ...v, series: { http_5xx_rate: constant(0.09), p99_latency_ms: constant(1200) } } : v));
  return { ...s, after: { ...s.after, variants } };
};

test("executes ready and approved actions in order and audits each one", async () => {
  const { c, bb } = await decided({ 2: "approved" });
  const t0 = c.clock.now().getTime();
  const out = await createExecutorNode(ed(c, guards()))(bb);
  assert.deepEqual(out.actions!.map((a) => a.status), ["succeeded", "succeeded", "succeeded"]);
  assert.equal(out.escalation, undefined);
  assert.equal(out.phase, "executing");
  assert.deepEqual(sinceGate(c, bb.incidentId), ["action_executed", "action_executed", "action_executed"]);
  assert.equal(out.world!.deployments["orders-api"]!.version, "v3.7.2");
  assert.deepEqual(out.world!.deployments["orders-api"]!.blockedTags, ["3.8.0"]);
  // Cada execução começa quando a anterior termina (duração do catálogo: 1, 90 e 5 s).
  assert.deepEqual(out.actions!.map((a) => (Date.parse(a.executedAt!) - t0) / 1000), [0, 1, 91]);
  assert.equal(c.clock.now().getTime() - t0, 96_000);
  assert.equal(out.actions![1]!.resultSummary, "deployment/orders-api: v3.8.0 -> v3.7.2 (6 replicas)");
  const handoffs = c.store.listTrace(bb.incidentId, { type: "handoff" }).filter((e) => e.payload.to === "executor");
  assert.deepEqual(handoffs.map((e) => e.payload.from), ["human"]);
  assert.deepEqual(c.store.listTrace(bb.incidentId, { agent: "executor", type: "action" }).map((e) => e.payload.tool), ["add_incident_note", "rollback_deployment", "block_image_tag"]);
  assert.deepEqual(c.store.listActions(bb.incidentId).map((a) => a.status), ["succeeded", "succeeded", "succeeded"]);
});

test("rejected dependency cancels dependents and no mitigation escalates mitigation_rejected", async () => {
  const { c, bb } = await decided({ 2: "rejected" });
  const out = await createExecutorNode(ed(c, guards()))(bb);
  assert.deepEqual(out.actions!.map((a) => a.status), ["succeeded", "rejected", "cancelled"]);
  assert.equal(out.escalation!.reason, "mitigation_rejected");
  assert.deepEqual(sinceGate(c, bb.incidentId), ["action_executed", "action_cancelled"]);
});

test("open breaker blocks execution and escalates circuit_open", async () => {
  const { c, bb } = await decided({ 2: "approved" });
  const g = guards();
  for (let i = 0; i < 3; i++) g.breaker.recordFailure(c.clock.now());
  const out = await createExecutorNode(ed(c, g))(bb);
  assert.deepEqual(out.actions!.map((a) => a.status), ["blocked_circuit_open", "blocked_circuit_open", "cancelled"]);
  assert.equal(out.escalation!.reason, "circuit_open");
  assert.deepEqual(sinceGate(c, bb.incidentId), ["action_blocked_circuit_open", "action_blocked_circuit_open", "action_cancelled"]);
  assert.equal(out.world!.deployments["orders-api"]!.version, "v3.8.0");
});

test("full limiter throttles and escalates throttled", async () => {
  const { c, bb } = await decided({ 2: "approved" });
  const g = guards();
  for (let i = 0; i < 5; i++) g.limiter.tryAcquire("add_incident_note", `incident/outro-${i}`, c.clock.now());
  const out = await createExecutorNode(ed(c, g))(bb);
  assert.deepEqual(out.actions!.map((a) => a.status), ["throttled", "throttled", "cancelled"]);
  assert.equal(out.escalation!.reason, "throttled");
  assert.ok(events(c, bb.incidentId).includes("action_throttled"));
});

test("execution failure records a breaker failure", async () => {
  const faults = (s: LoadedScenario): LoadedScenario => ({ ...s, file: { ...s.file, faults: { "rollback_deployment@deployment/orders-api": "fail" } } });
  const { c, bb } = await decided({ 2: "approved" }, { transformScenario: faults });
  const g = guards({ breaker: new CircuitBreaker({ failureThreshold: 1, cooldownSec: 300 }) });
  const out = await createExecutorNode(ed(c, g))(bb);
  assert.deepEqual(out.actions!.map((a) => a.status), ["succeeded", "failed", "cancelled"]);
  assert.match(out.actions![1]!.resultSummary!, /failure injected/);
  assert.equal(g.breaker.state(c.clock.now()), "open");
  assert.deepEqual(sinceGate(c, bb.incidentId), ["action_executed", "action_failed", "circuit_opened", "action_cancelled"]);
  assert.equal(out.escalation!.reason, "no_executable_actions");
});

test("healthy canary verifies; failing canary reverts in reverse order and escalates", async () => {
  {
    const { c, bb } = await decided({ 2: "approved" });
    const g = guards();
    g.breaker.recordFailure(c.clock.now());
    g.breaker.recordFailure(c.clock.now());
    const executed = { ...bb, ...(await createExecutorNode(ed(c, g))(bb)) };
    const t0 = c.clock.now().getTime();
    const ok = await createVerifierNode(ed(c, g))(executed);
    assert.equal(c.clock.now().getTime() - t0, 60_000);
    assert.equal(ok.verification!.healthy, true);
    assert.deepEqual(ok.verification!.checks.map((x) => [x.metric, x.observed, x.limit, x.passed]), [["http_5xx_rate", 0.005, 0.05, true], ["p99_latency_ms", 205, 270, true]]);
    assert.equal(ok.escalation, undefined);
    assert.equal(ok.phase, "verifying");
    const critique = c.store.listTrace(bb.incidentId, { type: "critique" }).at(-1)!;
    assert.deepEqual([critique.payload.by, critique.payload.verdict], ["canary", "approve"]);
    assert.match(critique.payload.feedback, /^healthy canary: 5xx 0.5% ≤ 5%; P99 205 ms ≤ 270 ms$/);
    const handoff = c.store.listTrace(bb.incidentId, { type: "handoff" }).at(-1)!;
    assert.deepEqual([handoff.payload.from, handoff.payload.to], ["verifier", "supervisor"]);
    // Sucesso do canário zera as falhas consecutivas: uma nova falha não abre o breaker.
    assert.equal(g.breaker.recordFailure(c.clock.now()), false);
  }
  {
    const { c, bb } = await decided({ 2: "approved" }, { transformScenario: badCanary });
    const id = bb.incidentId;
    const g = guards({ breaker: new CircuitBreaker({ failureThreshold: 1, cooldownSec: 300 }) });
    const executed = { ...bb, ...(await createExecutorNode(ed(c, g))(bb)) };
    const bad = await createVerifierNode(ed(c, g))(executed);
    assert.equal(bad.verification!.healthy, false);
    // Ordem da reversão: inversa da execução, só as reversíveis (add_incident_note não reverte).
    assert.deepEqual(c.store.listTrace(id, { agent: "verifier", type: "action" }).map((e) => e.payload.tool), ["revert:block_image_tag", "revert:rollback_deployment"]);
    assert.deepEqual(bad.actions!.map((a) => a.status), ["succeeded", "reverted", "reverted"]);
    assert.deepEqual(bad.verification!.revertedActionIds, [executed.actions[2]!.id, executed.actions[1]!.id]);
    assert.ok(c.store.listAudit(id).some((e) => e.event === "canary_rollback" && e.actor === "system:canary"));
    assert.ok(events(c, id).includes("circuit_opened"));
    assert.equal(bad.escalation!.reason, "remediation_ineffective");
    assert.equal(bad.world!.deployments["orders-api"]!.version, "v3.8.0");
    assert.deepEqual(bad.world!.deployments["orders-api"]!.blockedTags, []);
    const critique = c.store.listTrace(id, { type: "critique" }).at(-1)!;
    assert.deepEqual([critique.payload.by, critique.payload.verdict], ["canary", "reject"]);
    assert.match(critique.payload.feedback, /5xx 9% > 5%/);
    assert.deepEqual(c.store.listActions(id).map((a) => a.status), ["succeeded", "reverted", "reverted"]);
  }
});

test("escalation reason priority after the executor", () => {
  assert.equal(executorEscalationReason([act("throttled"), act("blocked_circuit_open"), act("rejected")]), "circuit_open");
  assert.equal(executorEscalationReason([act("rejected"), act("throttled")]), "throttled");
  assert.equal(executorEscalationReason([act("succeeded"), act("expired")]), "mitigation_rejected");
  assert.equal(executorEscalationReason([act("rejected")]), "mitigation_rejected");
  assert.equal(executorEscalationReason([act("failed"), act("cancelled")]), "no_executable_actions");
  assert.equal(executorEscalationReason([]), "no_executable_actions");
});
