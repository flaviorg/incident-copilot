import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalsDisabledError, AuthError, ConflictError, LockedError, NotFoundError, UnprocessableError, ValidationError } from "../../src/domain/errors.ts";
import { CircuitBreaker } from "../../src/domain/guards/circuit-breaker.ts";
import { ActionRateLimiter } from "../../src/domain/guards/action-rate-limiter.ts";
import type { LoadedScenario } from "../../src/infra/scenarios/scenario-loader.ts";
import type { RemediationPlan } from "../../src/contracts/index.ts";
import { createGateNode } from "../../src/graph/nodes/gate-node.ts";
import type { NodeFn } from "../../src/graph/run-context.ts";
import { createTestContainer } from "../helpers/container.ts";
import type { TestContainer, TestContainerOptions } from "../helpers/container.ts";
import { patchFixture, readFixture, turn } from "../helpers/fixtures.ts";

const TOKEN = "test-token-0123456789";
const DEPLOY = "deploy-5xx-rollback";
const open = async (o: TestContainerOptions = {}) => {
  const c = createTestContainer(o);
  return { c, v: await c.incidents.open({ scenarioId: DEPLOY }, { requestId: null }) };
};
const approveAs = (c: TestContainer, approver: string, id = "APR-0001") => c.approvals.decide(id, { decision: "approve", approver }, TOKEN, { requestId: null });

test("approve resumes and resolves", async () => {
  const { c, v } = await open();
  assert.equal(v.incident.status, "awaiting_approval");
  assert.deepEqual(v.approvals.map((a) => [a.id, a.status]), [["APR-0001", "pending"]]);
  c.clock.tick(180);
  const r = await c.approvals.decide("APR-0001", { decision: "approve", approver: "ana" }, TOKEN, { requestId: "req-approve" });
  assert.deepEqual([r.approval.status, r.approval.approver, r.approval.decisionSource], ["approved", "ana", "structured"]);
  assert.equal(r.incident.incident.status, "resolved");
  assert.equal(r.incident.verification!.healthy, true);
  assert.equal(c.store.listAudit(v.incident.id).filter((e) => e.event === "action_executed").length, 3);
  assert.equal(r.incident.metrics!.timeAwaitingApprovalMin, 3);
  assert.equal(r.incident.postmortemReady, true);
  assert.equal(c.store.getIncident(v.incident.id)!.status, "resolved");
  const decision = c.store.listAudit(v.incident.id).find((e) => e.event === "approval_approved")!;
  assert.deepEqual([decision.actor, decision.tier, decision.details.requestId], ["human:ana", 3, "req-approve"]);
  assert.deepEqual(c.store.listRuns(v.incident.id).map((x) => x.outcome), ["awaiting_approval", "resolved"]);
  c.fake.assertAllConsumed({ scenarioId: DEPLOY });
});

test("reject cancels dependents and escalates mitigation_rejected", async () => {
  const { c } = await open();
  const r = await c.approvals.decide("APR-0001", { decision: "reject", approver: "ana", comment: "prefiro investigar mais" }, TOKEN, { requestId: null });
  assert.deepEqual(r.incident.actions.map((a) => a.status), ["succeeded", "rejected", "cancelled"]);
  assert.equal(r.incident.incident.escalation!.reason, "mitigation_rejected");
  assert.equal(r.incident.incident.status, "escalated");
  assert.equal(c.incidents.postmortem(r.incident.incident.id).status, "partial");
  const events = c.store.listAudit(r.incident.incident.id).map((e) => e.event);
  assert.deepEqual(events.slice(4), ["approval_rejected", "action_cancelled", "action_executed", "incident_escalated"]);
  c.fake.assertAllConsumed({ scenarioId: DEPLOY, except: ["sup-5", "pm-1"] });
});

test("expired approval: reads project it, decision materializes it and answers approval_expired", async () => {
  const { c, v } = await open();
  c.clock.tick(31 * 60);
  assert.equal(c.approvals.list("expired")[0]!.id, "APR-0001");
  assert.deepEqual(c.approvals.list("pending"), []);
  assert.equal(c.store.getApproval("APR-0001")!.status, "pending");
  assert.equal(c.incidents.get(v.incident.id).approvals[0]!.status, "expired");
  await assert.rejects(c.approvals.decide("APR-0001", { decision: "approve", approver: "ana" }, TOKEN, { requestId: null }), (e) => e instanceof ConflictError && e.code === "approval_expired");
  const stored = c.store.getApproval("APR-0001")!;
  assert.deepEqual([stored.status, stored.decisionSource], ["expired", "expiry"]);
  const after = c.incidents.get(v.incident.id);
  assert.equal(after.incident.escalation!.reason, "mitigation_rejected");
  assert.deepEqual(after.actions.map((a) => a.status), ["succeeded", "expired", "cancelled"]);
  assert.ok(c.store.listAudit(v.incident.id).some((e) => e.event === "approval_expired" && e.actor === "system:approval-expiry"));
  // The expiry was already materialized: a new attempt is approval_not_pending.
  await assert.rejects(approveAs(c, "bia"), (e) => e instanceof ConflictError && e.code === "approval_not_pending");
});

test("token rules", async () => {
  const { c, v } = await open();
  await assert.rejects(c.approvals.decide("APR-0001", { decision: "approve", approver: "ana" }, "wrong-token-000000", { requestId: null }), AuthError);
  await assert.rejects(c.approvals.decide("APR-0001", { decision: "approve", approver: "ana" }, undefined, { requestId: null }), AuthError);
  const fail = c.store.listAudit(v.incident.id).find((e) => e.event === "approval_auth_failed")!;
  assert.ok(!JSON.stringify(fail).includes("wrong-token-000000"));
  assert.equal(c.store.getApproval("APR-0001")!.status, "pending");
  for (let i = 0; i < 3; i++) await c.approvals.decide("APR-0001", { decision: "approve", approver: "ana" }, "x".repeat(20), { requestId: null }).catch(() => {});
  await assert.rejects(approveAs(c, "ana"), LockedError);
  assert.ok(!c.logs.join("\n").includes("wrong-token-000000"));
  // After the 10-minute lockout, the right token is valid again.
  c.clock.tick(10 * 60 + 1);
  assert.equal((await approveAs(c, "ana")).approval.status, "approved");
  const off = createTestContainer({ approvalToken: null });
  await off.incidents.open({ scenarioId: DEPLOY }, { requestId: null });
  await assert.rejects(off.approvals.decide("APR-0001", { decision: "approve", approver: "ana" }, TOKEN, { requestId: null }), ApprovalsDisabledError);
});

test("ambiguous text changes nothing; exact text decides", async () => {
  const { c } = await open();
  await assert.rejects(c.approvals.decide("APR-0001", { text: "sim, mas espera", approver: "ana" }, TOKEN, { requestId: null }), (e) => e instanceof UnprocessableError && e.code === "ambiguous_decision");
  assert.equal(c.store.getApproval("APR-0001")!.status, "pending");
  await assert.rejects(c.approvals.decide("APR-9999", { decision: "approve", approver: "ana" }, TOKEN, { requestId: null }), NotFoundError);
  await assert.rejects(c.approvals.decide("APR-0001", { decision: "approve", text: "sim", approver: "ana" } as never, TOKEN, { requestId: null }), ValidationError);
  const r = await c.approvals.decide("APR-0001", { text: "  Sim. ", approver: "ana" }, TOKEN, { requestId: null });
  assert.deepEqual([r.approval.status, r.approval.decisionSource], ["approved", "text"]);
});

test("token pasted in the comment is redacted", async () => {
  const { c } = await open();
  await c.approvals.decide("APR-0001", { decision: "approve", approver: "ana", comment: `ok ${TOKEN}` }, TOKEN, { requestId: null });
  assert.equal(c.store.getApproval("APR-0001")!.comment, "ok [REDACTED]");
});

test("second decision is rejected and the action executes once", async () => {
  const { c, v } = await open();
  await approveAs(c, "ana");
  await assert.rejects(approveAs(c, "bia"), (e) => e instanceof ConflictError && e.code === "approval_not_pending");
  assert.equal(c.store.listAudit(v.incident.id).filter((e) => e.event === "action_executed" && e.details.actionType === "rollback_deployment").length, 1);
  // Two decisions fired together: one wins, the other gets 409, and the action runs only once.
  const { c: c2, v: v2 } = await open();
  const results = await Promise.allSettled([approveAs(c2, "ana"), approveAs(c2, "bia")]);
  assert.deepEqual(results.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(c2.store.listAudit(v2.incident.id).filter((e) => e.event === "action_executed" && e.details.actionType === "rollback_deployment").length, 1);
});

test("resumes after container restart on the same db file", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "ic-")), "ic.db");
  const a = createTestContainer({ dbPath });
  const v = await a.incidents.open({ scenarioId: DEPLOY }, { requestId: null });
  a.close();
  const b = createTestContainer({ dbPath });
  const r = await b.approvals.decide("APR-0001", { decision: "approve", approver: "ana" }, TOKEN, { requestId: null });
  assert.equal(r.incident.incident.id, v.incident.id);
  assert.equal(r.incident.incident.status, "resolved");
  b.close();
});

test("rejection cascades to a dependent step that was waiting for its own approval", async () => {
  // Step 3 without a runbook goes up to tier 3 and gets its own approval; it depends on the rollback.
  const base = readFixture("fixtures/llm/deploy-5xx-rollback.json");
  const plan = structuredClone(base.turns.find((t) => t.id === "plan-0")!.output) as RemediationPlan;
  plan.steps[2]!.runbookRef = null;
  const { c, v } = await open({ fixture: patchFixture(base, { replace: { "plan-0": { output: plan } } }) });
  assert.deepEqual(v.approvals.map((a) => a.id), ["APR-0001", "APR-0002"]);
  const r = await c.approvals.decide("APR-0001", { decision: "reject", approver: "ana" }, TOKEN, { requestId: null });
  assert.deepEqual(r.incident.actions.map((a) => a.status), ["succeeded", "rejected", "cancelled"]);
  const cascaded = c.store.getApproval("APR-0002")!;
  assert.equal(cascaded.status, "rejected");
  assert.match(cascaded.comment!, /cascade.*APR-0001/);
  assert.equal(r.incident.incident.escalation!.reason, "mitigation_rejected");
  await assert.rejects(approveAs(c, "bia", "APR-0002"), (e) => e instanceof ConflictError && e.code === "approval_not_pending");
});

test("failed dry run, open breaker, full limiter and failing canary end as the spec says", async () => {
  // Rollback to v9.9.9: the rollback_requires_recent_deploy rule rejects the plan in all 3 revisions; once the revisions are exhausted,
  // all steps go up to tier 3. The rollback dry run fails (no approval), the dependent is cancelled and only the
  // note asks for approval. Once the note is approved, nothing mitigating runs: no_executable_actions.
  {
    const base = readFixture("fixtures/llm/deploy-5xx-rollback.json");
    const plan = structuredClone(base.turns.find((t) => t.id === "plan-0")!.output) as RemediationPlan;
    plan.steps[1]!.params = { toVersion: "v9.9.9" };
    const audit = { verdict: "approve", feedback: "Plan follows the runbook." };
    const fixture = patchFixture(base, {
      replace: { "plan-0": { output: plan } },
      insertBefore: { "sup-4": [turn("plan-1", { revision: 1 }, plan, "planner.v1"), turn("aud-1", { revision: 1 }, audit, "auditor.v1"),
        turn("plan-2", { revision: 2 }, plan, "planner.v1"), turn("aud-2", { revision: 2 }, audit, "auditor.v1")] },
    });
    const { c, v } = await open({ fixture });
    assert.equal(v.planRevision, 2);
    assert.equal(v.audit!.overridden, true);
    assert.deepEqual(v.actions.map((a) => [a.tier, a.status]), [[3, "awaiting_approval"], [3, "rejected_by_dry_run"], [3, "cancelled"]]);
    assert.equal(v.actions[1]!.approvalId, null);
    assert.deepEqual(v.approvals.map((a) => a.actionId), [v.actions[0]!.id]);
    const r = await approveAs(c, "ana");
    assert.deepEqual(r.incident.actions.map((a) => a.status), ["succeeded", "rejected_by_dry_run", "cancelled"]);
    assert.equal(r.incident.incident.escalation!.reason, "no_executable_actions");
  }
  // Breaker open before execution: nothing runs and the incident escalates with circuit_open.
  {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownSec: 300 });
    const { c } = await open({ guards: { breaker } });
    c.clock.tick(180);
    for (let i = 0; i < 3; i++) breaker.recordFailure(c.clock.now());
    const r = await approveAs(c, "ana");
    assert.deepEqual(r.incident.actions.map((a) => a.status), ["blocked_circuit_open", "blocked_circuit_open", "cancelled"]);
    assert.equal(r.incident.incident.escalation!.reason, "circuit_open");
  }
  // Limiter full: executions are refused with throttled.
  {
    const limiter = new ActionRateLimiter({ perMinute: 5, repeatWindowMin: 10 });
    const { c } = await open({ guards: { limiter } });
    c.clock.tick(180);
    for (let i = 0; i < 5; i++) limiter.tryAcquire("tag_resource_for_review", `volume/outra/${i}`, c.clock.now());
    const r = await approveAs(c, "ana");
    assert.deepEqual(r.incident.actions.map((a) => a.status), ["throttled", "throttled", "cancelled"]);
    assert.equal(r.incident.incident.escalation!.reason, "throttled");
  }
  // Canary failed: reverts block_image_tag and rollback (reverse order), audits canary_rollback and escalates.
  {
    const constant = (value: number) => ({ segments: [{ fromSec: 0, toSec: 60, kind: "constant" as const, value }] });
    const badCanary = (s: LoadedScenario): LoadedScenario => (s.after
      ? { ...s, after: { ...s.after, variants: s.after.variants.map((x, i) => (i === 0 ? { ...x, series: { http_5xx_rate: constant(0.09), p99_latency_ms: constant(1200) } } : x)) } }
      : s);
    const { c, v } = await open({ transformScenario: badCanary });
    const r = await approveAs(c, "ana");
    assert.deepEqual(r.incident.actions.map((a) => a.status), ["succeeded", "reverted", "reverted"]);
    assert.ok(c.store.listAudit(v.incident.id).some((e) => e.event === "canary_rollback" && e.actor === "system:canary"));
    assert.equal(r.incident.incident.escalation!.reason, "remediation_ineffective");
    assert.equal(r.incident.verification!.healthy, false);
    assert.equal(c.store.loadBlackboard(v.incident.id).blackboard.world.deployments["orders-api"]!.version, "v3.8.0");
  }
});

/**
 * Container whose gate node is the real gate followed by `after`, in the same superstep. Simulates what arrives between the commit of the
 * approvals (done by the gate) and the final blackboard write (done at the end of the execution).
 */
function containerWithGateHook(after: (c: TestContainer) => Promise<void>): TestContainer {
  let realGate: NodeFn | null = null;
  const c: TestContainer = createTestContainer({
    nodes: {
      gate: async (s, cfg) => {
        const out = await realGate!(s, cfg);
        await after(c);
        return out;
      },
    },
  });
  realGate = createGateNode({
    infra: c.infra, trace: c.trace, clock: c.clock, ids: c.ids, approvalTtlMin: c.config.approvalTtlMin,
    persist: { action: (a) => c.store.upsertAction(a), approval: (a) => c.store.createApproval(a), audit: (e) => c.store.appendAudit(e) },
  });
  return c;
}

test("a decision sent while the opening run is still going is refused and the incident stays consistent", async () => {
  // Final review: the approval already shows as pending before the opening run writes the blackboard. A decision
  // in that window was accepted, sent the batch to the executor inside the opening and the final write fell into
  // version_conflict, leaving the incident unrecoverable.
  let during: unknown = null;
  const c = containerWithGateHook(async (c) => {
    assert.deepEqual(c.approvals.list("pending").map((a) => a.id), ["APR-0001"]);
    during = await approveAs(c, "ana").then(() => "aceita", (e: unknown) => e);
  });
  const v = await c.incidents.open({ scenarioId: DEPLOY }, { requestId: null });
  assert.ok(during instanceof ConflictError && during.code === "incident_not_accepting", String(during));
  assert.match((during as ConflictError).message, /run in progress/);
  assert.equal(v.incident.status, "awaiting_approval");
  assert.equal(c.store.getApproval("APR-0001")!.status, "pending");
  assert.ok(!c.store.listAudit(v.incident.id).some((e) => e.event === "approval_approved" || e.event === "action_executed"));
  assert.deepEqual(c.store.listRuns(v.incident.id).map((x) => x.outcome), ["awaiting_approval"]);
  // Once the opening finishes, the same decision is valid and the incident resolves.
  const r = await approveAs(c, "ana");
  assert.equal(r.incident.incident.status, "resolved");
  assert.deepEqual(c.store.listRuns(v.incident.id).map((x) => x.outcome), ["awaiting_approval", "resolved"]);
});

test("a run whose final save fails still records its end", async () => {
  // Any concurrent write to the blackboard fails the final write on version; the row in runs cannot be left without an end.
  const c = containerWithGateHook(async (c) => {
    const id = incidentIdOfStore(c);
    const { blackboard, version } = c.store.loadBlackboard(id);
    c.store.saveBlackboard(id, blackboard, version);
  });
  await assert.rejects(c.incidents.open({ scenarioId: DEPLOY }, { requestId: null }), (e) => e instanceof ConflictError && e.code === "version_conflict");
  const runs = c.store.listRuns(incidentIdOfStore(c));
  assert.equal(runs.length, 1);
  assert.notEqual(runs[0]!.endedAt, null);
  assert.equal(runs[0]!.outcome, "error: ConflictError");
});

const incidentIdOfStore = (c: TestContainer) => c.store.listIncidents({ limit: 1 })[0]!.id;

test("a decision that resumes the incident also records overdue sibling approvals as expired", async () => {
  // Review 2026-11: the gate approval (APR-0001) is overdue but unrecorded; an MCP proposal made later (APR-0002) is
  // still valid. Approving APR-0002 resumed the batch while APR-0001 stayed "pending" in the store, its action stayed
  // awaiting_approval and its dependents were never cancelled.
  const { c, v } = await open();
  c.clock.tick(20 * 60);
  const p = c.incidents.proposeExternalAction(
    { incidentId: v.incident.id, actionType: "rollback_deployment", target: "deployment/orders-api", params: { toVersion: "v3.7.2" }, rationale: "second opinion" },
    "mcp_client:tests",
  );
  assert.equal(p.approvalId, "APR-0002");
  c.clock.tick(15 * 60); // APR-0001 is now past its 30 min TTL; APR-0002 is not
  await approveAs(c, "ana", "APR-0002");
  const first = c.store.getApproval("APR-0001")!;
  assert.deepEqual([first.status, first.decisionSource], ["expired", "expiry"]);
  const audit = c.store.listAudit(v.incident.id);
  assert.ok(audit.some((e) => e.event === "approval_expired" && e.details.approvalId === "APR-0001"));
  const actions = c.store.listActions(v.incident.id);
  const step2 = actions.find((a) => a.order === 2)!;
  const step3 = actions.find((a) => a.order === 3)!;
  assert.equal(step2.status, "expired");
  assert.equal(step3.status, "cancelled");
});

test("a timeout escalation after the gate closes the pending approvals, and a late decision is refused", async () => {
  // Review 2026-11: a run that timed out right after the gate left APR-0001 pending on an escalated incident; a human
  // could then "approve" an action that would never run, and the audit said it was approved.
  let realGate: NodeFn | null = null;
  const c: TestContainer = createTestContainer({
    runTimeoutMs: 40,
    nodes: {
      gate: async (s, cfg) => {
        const out = await realGate!(s, cfg);
        await new Promise((r) => setTimeout(r, 80));
        return out;
      },
    },
  });
  realGate = createGateNode({
    infra: c.infra, trace: c.trace, clock: c.clock, ids: c.ids, approvalTtlMin: c.config.approvalTtlMin,
    persist: { action: (a) => c.store.upsertAction(a), approval: (a) => c.store.createApproval(a), audit: (e) => c.store.appendAudit(e) },
  });
  await assert.rejects(c.incidents.open({ scenarioId: DEPLOY }, { requestId: null }));
  const id = "INC-0001";
  assert.equal(c.incidents.get(id).incident.status, "escalated");
  assert.equal(c.store.getApproval("APR-0001")!.status, "expired");
  assert.deepEqual(c.approvals.list("pending"), []);
  const closed = c.store.listAudit(id).find((e) => e.event === "approval_expired" && e.details.approvalId === "APR-0001");
  assert.ok(closed, "approval closure is audited");
  assert.match(String(closed!.details.cause), /escalat/);
  assert.equal(c.store.listActions(id).find((a) => a.order === 2)!.status, "cancelled");
  await assert.rejects(approveAs(c, "ana"), (e) => e instanceof ConflictError);
  assert.ok(!c.store.listAudit(id).some((e) => e.event === "approval_approved"));
});

// ---------- Review 2026-11: failed reverts, stuck resume, abandoned runs ----------

const failingCanary = (s: LoadedScenario): LoadedScenario => {
  const constant = (value: number) => ({ segments: [{ fromSec: 0, toSec: 60, kind: "constant" as const, value }] });
  return s.after
    ? { ...s, after: { ...s.after, variants: s.after.variants.map((x, i) => (i === 0 ? { ...x, series: { http_5xx_rate: constant(0.09), p99_latency_ms: constant(1200) } } : x)) } }
    : s;
};

test("a revert that fails after a failed canary is recorded, audited and named in the escalation", async () => {
  const { c, v } = await open({ transformScenario: failingCanary });
  const realRevert = c.infra.revert.bind(c.infra);
  c.infra.revert = (w, a) => (a.actionType === "rollback_deployment"
    ? { world: w, result: { ok: false, summary: "deployment API refused the rollback" } }
    : realRevert(w, a));
  const r = await approveAs(c, "ana");
  const rollback = r.incident.actions.find((a) => a.actionType === "rollback_deployment")!;
  assert.equal(rollback.status, "succeeded", "the change is still in the world");
  assert.match(rollback.resultSummary ?? "", /revert FAILED: deployment API refused the rollback/);
  assert.match(c.store.listActions(v.incident.id).find((a) => a.id === rollback.id)!.resultSummary ?? "", /revert FAILED/, "persisted");
  const audit = c.store.listAudit(v.incident.id).find((e) => e.event === "canary_rollback")!;
  assert.deepEqual(audit.details.revertFailedActionIds, [rollback.id]);
  assert.match(r.incident.incident.escalation!.detail, /revert of rollback_deployment FAILED: deployment API refused the rollback/);
});

test("a resume that failed can be retried through IncidentService.resume once the run is closed", async () => {
  // A resume whose run throws (here: the executor node, once) left phase "resume" with every approval decided, and
  // decide() then answered approval_not_pending forever.
  let failOnce = true;
  let realExecutor: NodeFn | null = null;
  const c: TestContainer = createTestContainer({
    nodes: {
      executor: async (s, cfg) => {
        if (failOnce) { failOnce = false; throw new Error("executor defect"); }
        return realExecutor!(s, cfg);
      },
    },
  });
  const { createExecutorNode } = await import("../../src/graph/nodes/executor-node.ts");
  realExecutor = createExecutorNode({
    infra: c.infra, context: c.context, guards: c.guards, trace: c.trace, clock: c.clock,
    persist: { action: (a) => c.store.upsertAction(a), approval: (a) => c.store.createApproval(a), audit: (e) => c.store.appendAudit(e) },
  });
  const v = await c.incidents.open({ scenarioId: DEPLOY }, { requestId: null });
  await assert.rejects(approveAs(c, "ana"), /executor defect/);
  assert.equal(c.store.loadBlackboard(v.incident.id).blackboard.phase, "resume");
  await assert.rejects(approveAs(c, "ana"), (e) => e instanceof ConflictError && e.code === "approval_not_pending");
  const r = await c.incidents.resume(v.incident.id, { requestId: "req-retry" });
  assert.equal(r.incident.status, "resolved");
});

test("a run row left open by a crashed process is closed as abandoned after the lease, and decisions go through", async () => {
  const { c, v } = await open();
  // Another process crashed mid-run long ago: its row has no end.
  const old = new Date(c.clock.now().getTime() - (c.config.runTimeoutMs + 5 * 60_000)).toISOString();
  c.store.recordRun({ id: "RUN-CRASHED", incidentId: v.incident.id, startedAt: old, endedAt: null, outcome: null });
  const r = await approveAs(c, "ana");
  assert.equal(r.incident.incident.status, "resolved");
  const crashed = c.store.listRuns(v.incident.id).find((x) => x.id === "RUN-CRASHED")!;
  assert.notEqual(crashed.endedAt, null);
  assert.equal(crashed.outcome, "abandoned");
});

test("a recent open run from another process still blocks decisions", async () => {
  const { c, v } = await open();
  c.store.recordRun({ id: "RUN-ELSEWHERE", incidentId: v.incident.id, startedAt: c.clock.now().toISOString(), endedAt: null, outcome: null });
  await assert.rejects(approveAs(c, "ana"), (e) => e instanceof ConflictError && e.code === "incident_not_accepting");
});
