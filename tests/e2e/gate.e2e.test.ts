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
  // A expiração já foi materializada: nova tentativa é approval_not_pending.
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
  // Passados os 10 minutos de bloqueio, o token certo volta a valer.
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
  // Duas decisões disparadas juntas: uma vale, a outra recebe 409, e a ação roda uma vez só.
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
  // Passo 3 sem runbook sobe para faixa 3 e ganha a própria aprovação; ele depende do rollback.
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
  // Rollback para v9.9.9: a regra rollback_requires_recent_deploy reprova o plano nas 3 revisões; esgotadas as revisões,
  // todos os passos sobem para faixa 3. O dry run do rollback falha (sem aprovação), o dependente é cancelado e só a
  // nota pede aprovação. Aprovada a nota, nada mitigador roda: no_executable_actions.
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
  // Breaker aberto antes da execução: nada roda e o incidente escala com circuit_open.
  {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownSec: 300 });
    const { c } = await open({ guards: { breaker } });
    c.clock.tick(180);
    for (let i = 0; i < 3; i++) breaker.recordFailure(c.clock.now());
    const r = await approveAs(c, "ana");
    assert.deepEqual(r.incident.actions.map((a) => a.status), ["blocked_circuit_open", "blocked_circuit_open", "cancelled"]);
    assert.equal(r.incident.incident.escalation!.reason, "circuit_open");
  }
  // Limiter cheio: as execuções são recusadas com throttled.
  {
    const limiter = new ActionRateLimiter({ perMinute: 5, repeatWindowMin: 10 });
    const { c } = await open({ guards: { limiter } });
    c.clock.tick(180);
    for (let i = 0; i < 5; i++) limiter.tryAcquire("tag_resource_for_review", `volume/outra/${i}`, c.clock.now());
    const r = await approveAs(c, "ana");
    assert.deepEqual(r.incident.actions.map((a) => a.status), ["throttled", "throttled", "cancelled"]);
    assert.equal(r.incident.incident.escalation!.reason, "throttled");
  }
  // Canário reprovado: reverte block_image_tag e rollback (ordem inversa), audita canary_rollback e escala.
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
 * Container cujo nó gate é o portão real seguido de `after`, no mesmo superstep. Simula o que chega entre o commit das
 * aprovações (feito pelo portão) e a gravação final do blackboard (feita no fim da execução).
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
  // Revisão final: a aprovação já aparece pendente antes de a execução de abertura gravar o blackboard. Uma decisão
  // nessa janela era aceita, mandava o lote para o executor dentro da abertura e a gravação final caía em
  // version_conflict, deixando o incidente irrecuperável.
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
  // Terminada a abertura, a mesma decisão vale e o incidente resolve.
  const r = await approveAs(c, "ana");
  assert.equal(r.incident.incident.status, "resolved");
  assert.deepEqual(c.store.listRuns(v.incident.id).map((x) => x.outcome), ["awaiting_approval", "resolved"]);
});

test("a run whose final save fails still records its end", async () => {
  // Qualquer escrita concorrente no blackboard derruba a gravação final por versão; a linha em runs não pode ficar sem fim.
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
