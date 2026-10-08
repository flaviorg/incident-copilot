import { test } from "node:test";
import assert from "node:assert/strict";
import { auditInventory } from "../../src/domain/finops/inventory-audit.ts";
import { IncidentViewSchema } from "../../src/contracts/index.ts";
import { assertGolden, runScenarioBranch } from "../helpers/golden.ts";

test("deploy approved: resolved, tiers, audit trail, golden metrics, every turn consumed", async () => {
  const { c, view } = await runScenarioBranch("deploy-5xx-rollback", "approved");
  assert.equal(IncidentViewSchema.safeParse(view).success, true);
  assert.equal(view.incident.status, "resolved");
  assert.deepEqual(view.actions.map((a) => [a.actionType, a.tier, a.status]), [["add_incident_note", 2, "succeeded"], ["rollback_deployment", 3, "succeeded"], ["block_image_tag", 2, "succeeded"]]);
  assert.deepEqual(c.store.listAudit(view.incident.id).map((e) => e.event), [
    "incident_opened", "action_ready", "approval_requested", "action_ready", "approval_approved", "action_executed", "action_executed", "action_executed", "incident_resolved",
  ]);
  assert.ok(Math.abs(view.metrics!.mttrMin! - 11.18) < 0.05, String(view.metrics!.mttrMin));
  assert.equal(view.metrics!.timeAwaitingApprovalMin, 3);
  assert.equal(view.incident.resolvedAt, "2026-10-04T09:51:41.000Z");
  const pm = c.incidents.postmortem(view.incident.id);
  assert.deepEqual([pm.status, pm.generatedBy.model, pm.numericGuard.passed], ["final", "fake/scripted", true]);
  assertGolden("metrics.deploy-5xx-rollback.approved", view.metrics);
  c.fake.assertAllConsumed({ scenarioId: "deploy-5xx-rollback" });
});

test("deploy rejected: escalated mitigation_rejected", async () => {
  const { c, view } = await runScenarioBranch("deploy-5xx-rollback", "rejected");
  assert.equal(view.incident.status, "escalated");
  assert.equal(view.incident.escalation!.reason, "mitigation_rejected");
  assert.deepEqual(view.actions.map((a) => a.status), ["succeeded", "rejected", "cancelled"]);
  assert.equal(c.incidents.postmortem(view.incident.id).status, "partial");
  assert.equal(view.metrics!.mttrMin, null);
  assertGolden("metrics.deploy-5xx-rollback.rejected", view.metrics);
  c.fake.assertAllConsumed({ scenarioId: "deploy-5xx-rollback", except: ["sup-5", "pm-1"] });
});

test("cost approved: Reflection, tier 4 blocked, savings from the inventory", async () => {
  const { c, view } = await runScenarioBranch("cost-anomaly", "approved");
  assert.equal(view.planRevision, 1);
  const by = Object.fromEntries(view.actions.map((a) => [a.actionType, a]));
  assert.deepEqual([by.delete_backups!.tier, by.delete_backups!.status, by.delete_backups!.dryRun], [4, "blocked_forbidden", null]);
  assert.deepEqual(view.actions.map((a) => [a.actionType, a.tier, a.status]), [
    ["tag_resource_for_review", 2, "succeeded"], ["create_volume_snapshot", 2, "succeeded"], ["delete_volume", 3, "succeeded"],
    ["release_elastic_ip", 3, "succeeded"], ["resize_instance", 3, "succeeded"], ["delete_backups", 4, "blocked_forbidden"],
  ]);
  assert.equal(view.incident.status, "resolved");
  assert.equal(view.approvals.length, 3);
  const expected = auditInventory(c.scenarios.get("cost-anomaly").inventory!, c.prices).totalMonthlySavingsUsd;
  assert.equal(expected, 339.59);
  assert.equal(view.metrics!.monthlySavingsUsd, expected); // 339,59 com os dados do projeto
  assert.equal(view.verification!.checks[0]!.observed, 356.94);
  const pm = c.incidents.postmortem(view.incident.id);
  assert.deepEqual([pm.status, pm.generatedBy.model, pm.numericGuard.passed, pm.impact.monthlySavingsUsd], ["final", "fake/scripted", true, 339.59]);
  assertGolden("metrics.cost-anomaly.approved", view.metrics);
  c.fake.assertAllConsumed({ scenarioId: "cost-anomaly" });
});

test("cost rejected: tier 2 ran, tier 3 rejected, escalated", async () => {
  const { c, view } = await runScenarioBranch("cost-anomaly", "rejected");
  assert.deepEqual(view.actions.map((a) => [a.actionType, a.status]), [
    ["tag_resource_for_review", "succeeded"], ["create_volume_snapshot", "succeeded"], ["delete_volume", "rejected"],
    ["release_elastic_ip", "rejected"], ["resize_instance", "rejected"], ["delete_backups", "blocked_forbidden"],
  ]);
  assert.equal(view.incident.escalation!.reason, "mitigation_rejected");
  assert.equal(view.metrics!.monthlySavingsUsd, 0);
  assertGolden("metrics.cost-anomaly.rejected", view.metrics);
  c.fake.assertAllConsumed({ scenarioId: "cost-anomaly", except: ["sup-5", "pm-1"] });
});
