import { test } from "node:test";
import assert from "node:assert/strict";
import {
  afterAuditor, afterExecutor, afterGate, afterPlanner, afterSpecialist, afterSupervisor, afterVerifier, entryRoute, GRAPH_NODE_ID, NODE_NAMES,
} from "../../src/graph/routing.ts";
import { BlackboardSchema } from "../../src/contracts/index.ts";
import type { HandoffRecord } from "../../src/contracts/index.ts";
import { act, audit, bb, esc, healthy, L } from "../helpers/blackboard.ts";

const decided = (to: HandoffRecord["to"]): HandoffRecord => ({ iteration: 1, from: "supervisor", to, brief: "b", reason: "r", coerced: false });

test("entry by phase", () => {
  assert.equal(entryRoute(bb({ phase: "new" })), "supervisor");
  assert.equal(entryRoute(bb({ phase: "resume" })), "executor");
});

test("escalation set by any node wins", () => {
  assert.equal(afterSpecialist(bb({ escalation: esc() })), "escalation");
  assert.equal(afterPlanner(bb({ escalation: esc() })), "escalation");
  assert.equal(afterSupervisor(bb({ escalation: esc(), supervisor: { iterations: 1, history: [decided("gate")] } })), "escalation");
  assert.equal(afterVerifier(bb({ escalation: esc(), verification: healthy() })), "escalation");
  assert.equal(afterSpecialist(bb()), "supervisor");
  assert.equal(afterPlanner(bb()), "auditor");
});

test("supervisor routes to the target of its last decision", () => {
  assert.equal(afterSupervisor(bb({ supervisor: { iterations: 2, history: [decided("telemetry_analyst"), decided("runbook_retriever")] } })), "runbook_retriever");
  assert.equal(afterSupervisor(bb({ supervisor: { iterations: 1, history: [decided("reporter")] } })), "reporter");
  assert.throws(() => afterSupervisor(bb()), /sem decisão/);
});

test("auditor loops at most maxPlanRevisions times", () => {
  assert.equal(afterAuditor(bb({ audit: audit("revise"), planRevision: 1 }), L), "remediation_planner");
  assert.equal(afterAuditor(bb({ audit: audit("revise"), planRevision: 2 }), L), "supervisor");
  assert.equal(afterAuditor(bb({ audit: audit("approve"), planRevision: 0 }), L), "supervisor");
});

test("gate routes", () => {
  assert.equal(afterGate(bb({ actions: [act("awaiting_approval")] }), 1), "__end__");
  assert.equal(afterGate(bb({ actions: [act("ready")] }), 0), "executor");
  assert.equal(afterGate(bb({ actions: [act("blocked_forbidden")] }), 0), "escalation");
  assert.equal(afterGate(bb(), 0), "escalation");
});

test("executor goes to the verifier only after a succeeded mitigating action", () => {
  const mitigating = (t: string) => t === "rollback_deployment";
  assert.equal(afterExecutor(bb({ actions: [act("succeeded")] }), mitigating), "verifier");
  assert.equal(afterExecutor(bb({ actions: [act("failed")] }), mitigating), "escalation");
  assert.equal(afterExecutor(bb({ actions: [act("succeeded", { actionType: "add_incident_note" })] }), mitigating), "escalation");
});

test("verifier: healthy canary goes back to the supervisor", () => {
  assert.equal(afterVerifier(bb({ verification: healthy() })), "supervisor");
  assert.equal(afterVerifier(bb({ verification: { healthy: false, checks: [], revertedActionIds: [] } })), "escalation");
});

test("graph node ids never collide with blackboard keys (LangGraph refuses a node named like a state channel)", () => {
  const keys = new Set(Object.keys(BlackboardSchema.shape));
  const ids = NODE_NAMES.map((n) => GRAPH_NODE_ID[n]);
  assert.deepEqual(ids.filter((id) => keys.has(id)), []);
  assert.equal(new Set(ids).size, NODE_NAMES.length);
  assert.equal(GRAPH_NODE_ID.telemetry_analyst, "telemetry_analyst");
});
