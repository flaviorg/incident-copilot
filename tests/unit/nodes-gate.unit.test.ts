import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateNode } from "../../src/graph/nodes/gate-node.ts";
import type { Blackboard, PlanStep } from "../../src/contracts/index.ts";
import type { Container } from "../../src/app/container.ts";
import { countByType, stateAtGate } from "../helpers/container.ts";

const gd = (c: Container) => ({
  infra: c.infra,
  trace: c.trace,
  clock: c.clock,
  ids: c.ids,
  approvalTtlMin: c.config.approvalTtlMin,
  persist: { action: c.store.upsertAction.bind(c.store), approval: c.store.createApproval.bind(c.store), audit: c.store.appendAudit.bind(c.store) },
});

const withSteps = (bb: Blackboard, f: (steps: PlanStep[]) => PlanStep[]): Blackboard => ({ ...bb, plan: { ...bb.plan!, steps: f(structuredClone(bb.plan!.steps)) } });
const gateEvents = (c: Container, id: string) => c.store.listTrace(id, { agent: "gate" });

test("deploy plan: note ready, rollback awaiting approval, block_image_tag ready", async () => {
  const { c, bb } = await stateAtGate("deploy-5xx-rollback");
  const before = c.clock.now().getTime();
  const out = await createGateNode(gd(c))(bb);
  assert.deepEqual(out.actions!.map((a) => [a.actionType, a.tier, a.status]), [["add_incident_note", 2, "ready"], ["rollback_deployment", 3, "awaiting_approval"], ["block_image_tag", 2, "ready"]]);
  assert.equal(out.phase, "awaiting_approval");
  assert.equal("world" in out, false); // o mundo hipotético do dry run não vaza para o blackboard
  assert.equal(c.clock.now().getTime() - before, 6_000); // 2 s por dry run
  const apr = c.store.listApprovals({ incidentId: bb.incidentId })[0]!;
  assert.equal(apr.status, "pending");
  assert.equal(apr.actionId, out.actions![1]!.id);
  assert.equal(out.actions![1]!.approvalId, apr.id);
  assert.equal(Date.parse(apr.expiresAt) - Date.parse(apr.requestedAt), 30 * 60_000);
  // As decisões do portão saem juntas, no fim do lote: o pedido de aprovação é desse instante.
  assert.equal(apr.requestedAt, c.clock.now().toISOString());
  assert.deepEqual(out.actions!.map((a) => a.dryRun?.ok), [true, true, true]);
  assert.deepEqual(out.actions![1]!.dryRun!.changes, ["deployment/orders-api: v3.8.0 -> v3.7.2 (6 replicas)"]);
  assert.deepEqual(out.actions!.map((a) => a.classificationReasons), [["catalog tier: 2"], ["catalog tier: 3"], ["catalog tier: 2"]]);
  const events = gateEvents(c, bb.incidentId);
  assert.ok(countByType(events).action! >= 3);
  assert.deepEqual(events.filter((e) => e.type === "action").map((e) => e.type === "action" && [e.payload.tool, e.payload.tier]), [["add_incident_note", 2], ["rollback_deployment", 3], ["block_image_tag", 2]]);
  assert.equal(countByType(events).observation, 3);
  const handoff = events.find((e) => e.type === "handoff")!;
  assert.ok(handoff.type === "handoff" && handoff.payload.to === "human" && handoff.payload.brief.includes(apr.id));
  assert.deepEqual(c.store.listAudit(bb.incidentId).map((e) => e.event), ["incident_opened", "action_ready", "approval_requested", "action_ready"]);
  assert.deepEqual(c.store.listActions(bb.incidentId), out.actions);
});

test("forbidden step is blocked without dry run, with audit and critique", async () => {
  const { c, bb } = await stateAtGate("deploy-5xx-rollback", { extraStep: { actionType: "delete_backups", target: "backup_vault/orders-api/prod" } });
  const a = (await createGateNode(gd(c))(bb)).actions!.find((x) => x.actionType === "delete_backups")!;
  assert.deepEqual([a.status, a.tier, a.dryRun, a.approvalId], ["blocked_forbidden", 4, null, null]);
  assert.deepEqual(a.classificationReasons, ["forbidden by construction (tier 4)"]);
  assert.ok(c.store.listAudit(bb.incidentId).some((e) => e.event === "action_blocked_forbidden" && e.tier === 4));
  assert.ok(c.store.listTrace(bb.incidentId, { type: "critique" }).some((e) => e.payload.by === "gate" && e.payload.verdict === "blocked"));
  assert.equal(c.store.listApprovals({ incidentId: bb.incidentId }).length, 1); // só a do rollback
});

test("unknown type, failed dry run, dependents and scope", async () => {
  const { c, bb } = await stateAtGate("deploy-5xx-rollback");
  const state = withSteps(bb, (steps) => {
    steps[1]!.params = { toVersion: "v9.9.9" };
    return [
      ...steps,
      { order: 4, actionType: "capture_heap_dump", target: "deployment/orders-api", params: {}, rationale: "r", runbookRef: null, dependsOn: [] },
      { order: 5, actionType: "add_incident_note", target: "incident/INC-9999", params: { text: "note on another incident" }, rationale: "r", runbookRef: "orders-5xx-after-deploy#mitigation", dependsOn: [] },
    ];
  });
  const out = await createGateNode(gd(c))(state);
  assert.deepEqual(out.actions!.map((a) => [a.order, a.tier, a.status]), [
    [1, 2, "ready"], [2, 3, "rejected_by_dry_run"], [3, 2, "cancelled"], [4, 4, "blocked_unknown"], [5, 3, "awaiting_approval"],
  ]);
  const [, rollback, block, unknown, outOfScope] = out.actions!;
  assert.match(rollback!.dryRun!.failureReason!, /v9\.9\.9 is not in the deploy history/);
  assert.equal(rollback!.approvalId, null);
  assert.equal(block!.dryRun, null);
  assert.deepEqual(unknown!.classificationReasons, ["type not in catalog: deny by default"]);
  assert.ok(outOfScope!.classificationReasons.includes("target outside the incident scope"));
  assert.deepEqual(c.store.listApprovals({ incidentId: bb.incidentId }).map((a) => a.actionId), [outOfScope!.id]);
  const events = c.store.listAudit(bb.incidentId).map((e) => e.event);
  assert.deepEqual(events.slice(1), ["action_ready", "action_dry_run_failed", "action_cancelled", "action_blocked_unknown", "approval_requested"]);
});

test("exhausted revisions raise every step to tier 3", async () => {
  const { c, bb } = await stateAtGate("deploy-5xx-rollback");
  const out = await createGateNode(gd(c))({ ...bb, audit: { ...bb.audit!, verdict: "revise" } });
  assert.deepEqual(out.actions!.map((a) => [a.tier, a.status]), [[3, "awaiting_approval"], [3, "awaiting_approval"], [3, "awaiting_approval"]]);
  assert.ok(out.actions!.every((a) => a.classificationReasons.includes("plan revisions exhausted")));
  assert.equal(c.store.listApprovals({ incidentId: bb.incidentId }).length, 3);
  const handoff = gateEvents(c, bb.incidentId).find((e) => e.type === "handoff")!;
  assert.ok(handoff.type === "handoff" && handoff.payload.brief.includes("APR-0001, APR-0002, APR-0003"));
});

test("invalid params are rejected without dry run; with nothing pending the gate hands off to the executor", async () => {
  const { c, bb } = await stateAtGate("deploy-5xx-rollback");
  const state = withSteps(bb, (steps) => {
    steps[1]!.params = {};
    return steps;
  });
  const out = await createGateNode(gd(c))(state);
  assert.deepEqual(out.actions!.map((a) => a.status), ["ready", "rejected_invalid_params", "cancelled"]);
  assert.equal(out.actions![1]!.dryRun, null);
  assert.equal(out.phase, "executing");
  assert.equal(c.store.listApprovals({ incidentId: bb.incidentId }).length, 0);
  const handoff = gateEvents(c, bb.incidentId).find((e) => e.type === "handoff")!;
  assert.ok(handoff.type === "handoff" && handoff.payload.to === "executor");
  assert.ok(c.store.listAudit(bb.incidentId).some((e) => e.event === "action_rejected_invalid_params"));
});
