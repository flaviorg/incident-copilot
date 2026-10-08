import { test } from "node:test";
import assert from "node:assert/strict";
import { AUDITOR_RULE_IDS, combineAuditorVerdict, runAuditorRules } from "../../src/domain/audit/auditor-rules.ts";
import type { AuditEvidence } from "../../src/domain/audit/auditor-rules.ts";
import { impactStartOf } from "../../src/domain/metrics/incident-metrics.ts";
import { ScenarioRepository } from "../../src/infra/scenarios/scenario-loader.ts";
import { projectPath } from "../../src/infra/paths.ts";
import type { AuditCheck, PlanStep, RemediationPlan } from "../../src/contracts/index.ts";
import { readFixture } from "../helpers/fixtures.ts";

const scenarios = new ScenarioRepository({ rootDir: projectPath("fixtures", "scenarios") });
const cost = scenarios.get("cost-anomaly");
const deploy = scenarios.get("deploy-5xx-rollback");
const costEv: AuditEvidence = { inventory: cost.inventory, deploys: cost.deploys, impactStartedAt: impactStartOf(cost.alert, cost.series) };
const deployEv: AuditEvidence = { inventory: null, deploys: deploy.deploys, impactStartedAt: impactStartOf(deploy.alert, deploy.series) };

// Os planos dos cenários vêm das próprias fixtures do fake, para a regra e o roteiro não divergirem.
const planTurn = (file: string, id: string) => readFixture(file).turns.find((t) => t.id === id)!.output as RemediationPlan;
const costRev0 = () => planTurn("fixtures/llm/cost-anomaly.json", "plan-0");
const costRev1 = () => planTurn("fixtures/llm/cost-anomaly.json", "plan-1");
const deployRev0 = () => planTurn("fixtures/llm/deploy-5xx-rollback.json", "plan-0");

const step = (order: number, actionType: string, target: string, params: Record<string, unknown> = {}, dependsOn: number[] = []): PlanStep =>
  ({ order, actionType, target, params, rationale: "teste", runbookRef: null, dependsOn });
const plan = (steps: PlanStep[]): RemediationPlan => ({ summary: "teste", steps });
const resize = (target: string) => step(1, "resize_instance", target, { toType: "r6i.large" });
const rollback = (toVersion: string) => step(1, "rollback_deployment", "deployment/orders-api", { toVersion });
const failed = (checks: AuditCheck[]) => checks.filter((c) => !c.passed).map((c) => c.rule).join(",");
const passing = (): AuditCheck[] => AUDITOR_RULE_IDS.map((rule) => ({ rule, passed: true, detail: "ok" }));
const failing = (): AuditCheck[] => passing().map((c, i) => (i === 0 ? { ...c, passed: false } : c));

test("one check per rule; rules without applicable steps pass as not applicable", () => {
  const checks = runAuditorRules(deployRev0(), deployEv);
  assert.deepEqual(checks.map((c) => c.rule), [...AUDITOR_RULE_IDS]);
  assert.ok(checks.every((c) => c.passed && c.detail.length <= 300));
  assert.equal(checks.find((c) => c.rule === "snapshot_before_delete")!.detail, "não se aplica");
});

test("delete_volume without a prior snapshot fails", () => assert.equal(failed(runAuditorRules(costRev0(), costEv)), "snapshot_before_delete"));

test("revision 1 passes every rule", () => assert.ok(runAuditorRules(costRev1(), costEv).every((c) => c.passed)));

test("resize needs CPU at most 10%", () => {
  assert.equal(failed(runAuditorRules(plan([resize("instance/data-platform/i-0db51")]), costEv)), "resize_requires_low_cpu");
  assert.equal(failed(runAuditorRules(plan([resize("instance/data-platform/i-07ab3")]), costEv)), "");
  assert.equal(failed(runAuditorRules(plan([resize("instance/data-platform/i-07ab3")]), { ...costEv, inventory: null })), "resize_requires_low_cpu");
});

test("release needs an unassociated IP", () => {
  const release = plan([step(1, "release_elastic_ip", "ip/data-platform/eipalloc-0f19")]);
  assert.equal(failed(runAuditorRules(release, costEv)), "");
  const associated = { ...costEv, inventory: { ...cost.inventory!, publicIps: [{ id: "eipalloc-0f19", associatedWith: "i-0db51" }] } };
  assert.equal(failed(runAuditorRules(release, associated)), "release_requires_unassociated");
  assert.equal(failed(runAuditorRules(plan([step(1, "release_elastic_ip", "ip/data-platform/eipalloc-zzzz")]), costEv)), "release_requires_unassociated");
});

test("rollback needs a recent deploy and the previous version", () => {
  assert.equal(failed(runAuditorRules(plan([rollback("v3.7.1")]), deployEv)), "rollback_requires_recent_deploy");
  assert.ok(runAuditorRules(plan([rollback("v3.7.2")]), deployEv).every((c) => c.passed));
  assert.equal(failed(runAuditorRules(plan([rollback("v3.7.2")]), { ...deployEv, impactStartedAt: "2026-10-04T12:00:00.000Z" })), "rollback_requires_recent_deploy");
});

test("dependsOn must point to an earlier existing step", () => {
  const p = plan([step(1, "add_incident_note", "incident/orders-api"), step(2, "rollback_deployment", "deployment/orders-api", { toVersion: "v3.7.2" }), step(3, "block_image_tag", "image/orders-api:3.8.0", {}, [5])]);
  assert.equal(failed(runAuditorRules(p, deployEv)), "depends_on_valid");
  const forward = plan([step(1, "add_incident_note", "incident/orders-api", {}, [2]), step(2, "rollback_deployment", "deployment/orders-api", { toVersion: "v3.7.2" })]);
  assert.equal(failed(runAuditorRules(forward, deployEv)), "depends_on_valid");
});

test("verdict combination: code is the floor", () => {
  assert.deepEqual(combineAuditorVerdict(passing(), "approve"), { verdict: "approve", overridden: false });
  assert.deepEqual(combineAuditorVerdict(passing(), "revise"), { verdict: "revise", overridden: false });
  assert.deepEqual(combineAuditorVerdict(failing(), "revise"), { verdict: "revise", overridden: false });
  assert.deepEqual(combineAuditorVerdict(failing(), "approve"), { verdict: "revise", overridden: true });
  assert.deepEqual(combineAuditorVerdict(failing(), null), { verdict: "revise", overridden: false });
  assert.deepEqual(combineAuditorVerdict(passing(), null), { verdict: "approve", overridden: false });
});
