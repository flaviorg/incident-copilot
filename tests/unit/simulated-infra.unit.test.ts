import { test } from "node:test";
import assert from "node:assert/strict";
import { SimulatedInfra, projectedMonthlyCostUsd } from "../../src/infra/simulated-infra.ts";
import type { ValidatedStep } from "../../src/infra/simulated-infra.ts";
import { ScenarioRepository } from "../../src/infra/scenarios/scenario-loader.ts";
import type { LoadedScenario } from "../../src/infra/scenarios/scenario-loader.ts";
import { CloudPricesSchema, loadDataFile } from "../../src/infra/data-files.ts";
import { projectPath } from "../../src/infra/paths.ts";
import { auditInventory } from "../../src/domain/finops/inventory-audit.ts";
import { WorldStateSchema } from "../../src/contracts/index.ts";
import type { GatedAction } from "../../src/contracts/index.ts";

const prices = loadDataFile(projectPath("data", "cloud-prices.json"), CloudPricesSchema);
const infra = new SimulatedInfra({ prices });
const repo = (transform?: (s: LoadedScenario) => LoadedScenario) =>
  new ScenarioRepository({ rootDir: projectPath("fixtures", "scenarios"), ...(transform ? { transform } : {}) });
const scenarios = repo();
const deploy = scenarios.get("deploy-5xx-rollback");
const cost = scenarios.get("cost-anomaly");
const w0 = infra.initialWorld(deploy);
const costWorld = infra.initialWorld(cost);

function gated(step: ValidatedStep, status: GatedAction["status"]): GatedAction {
  return {
    id: "ACT-0001", incidentId: "INC-0001", planRevision: 0, order: 1, actionType: step.actionType, target: step.target, params: step.params,
    dependsOn: [], tier: 3, classificationReasons: [], status, dryRun: null, approvalId: null, proposedBy: "remediation_planner",
    executedAt: "2026-10-04T09:49:06.000Z", resultSummary: null,
  };
}

const rollback: ValidatedStep = { actionType: "rollback_deployment", target: "deployment/orders-api", params: { toVersion: "v3.7.2" } };

test("initial world: deployments with history, inventory and a frozen copy of it", () => {
  assert.equal(WorldStateSchema.safeParse(w0).success, true);
  assert.deepEqual(w0.deployments["orders-api"], { version: "v3.8.0", previousVersion: "v3.7.2", replicas: 6, blockedTags: [], history: ["v3.7.1", "v3.7.2", "v3.8.0"] });
  assert.equal(w0.inventory, null);
  assert.deepEqual(costWorld.inventory, cost.inventory);
  assert.deepEqual(costWorld.initialInventory, cost.inventory);
  assert.notEqual(costWorld.inventory, cost.inventory);
  assert.deepEqual(infra.facts(w0), { "deployment.orders-api.version": "v3.8.0", "deployment.orders-api.previousVersion": "v3.7.2", "deployment.orders-api.replicas": "6" });
});

test("rollback dry run, execution, healthy signals and revert", () => {
  const dry = infra.dryRun(w0, rollback);
  assert.deepEqual(dry, { ok: true, changes: ["deployment/orders-api: v3.8.0 -> v3.7.2 (6 replicas)"], reversible: true, estimatedDurationSec: 90, failureReason: null });
  assert.equal(infra.facts(w0)["deployment.orders-api.version"], "v3.8.0"); // dry run não muda o mundo
  const { world: w1, result } = infra.execute(w0, rollback, deploy);
  assert.equal(result.ok, true);
  assert.equal(result.summary, "deployment/orders-api: v3.8.0 -> v3.7.2 (6 replicas)");
  assert.equal(infra.facts(w1)["deployment.orders-api.version"], "v3.7.2");
  assert.ok(Math.max(...infra.postActionSignals(w1, deploy).metrics.http_5xx_rate!) <= 0.05);
  assert.ok(Math.min(...infra.postActionSignals(w0, deploy).metrics.http_5xx_rate!) > 0.05);
  assert.equal(infra.postActionSignals(w1, deploy).metrics.p99_latency_ms!.length, 7); // 60 s em passos de 10 s
  const reverted = infra.revert(w1, gated(rollback, "succeeded"));
  assert.equal(reverted.result.ok, true);
  assert.deepEqual(reverted.world.deployments["orders-api"], w0.deployments["orders-api"]);
});

test("dry run failures", () => {
  assert.match(infra.dryRun(w0, { actionType: "rollback_deployment", target: "deployment/orders-api", params: { toVersion: "v9.9.9" } }).failureReason!, /version v9\.9\.9 is not in the deploy history/);
  assert.match(infra.dryRun(w0, { actionType: "rollback_deployment", target: "deployment/orders-api", params: { toVersion: "v3.8.0" } }).failureReason!, /already runs v3\.8\.0/);
  assert.match(infra.dryRun(w0, { actionType: "rollback_deployment", target: "deployment/payments-api", params: { toVersion: "v1" } }).failureReason!, /target not found/);
  assert.match(infra.dryRun(w0, { actionType: "rollback_deployment", target: "image/orders-api:3.8.0", params: { toVersion: "v3.7.2" } }).failureReason!, /target not found/);
  assert.match(infra.dryRun(w0, { actionType: "block_image_tag", target: "image/orders-api:9.9.9", params: {} }).failureReason!, /9\.9\.9 is not in the deploy history/);
  const attached = infra.dryRun(costWorld, { actionType: "delete_volume", target: "volume/data-platform/vol-0a77e9", params: {} });
  assert.deepEqual([attached.ok, attached.failureReason], [false, "volume vol-0a77e9 attached to i-0db51"]);
  assert.match(infra.dryRun(costWorld, { actionType: "release_elastic_ip", target: "ip/data-platform/eipalloc-9999", params: {} }).failureReason!, /target not found/);
  assert.match(infra.dryRun(costWorld, { actionType: "resize_instance", target: "instance/data-platform/i-07ab3", params: { toType: "m9.huge" } }).failureReason!, /m9\.huge has no price/);
  assert.match(infra.dryRun(costWorld, { actionType: "create_volume_snapshot", target: "volume/data-platform/vol-nope", params: {} }).failureReason!, /target not found/);
  assert.match(infra.dryRun(costWorld, { actionType: "tag_resource_for_review", target: "volume/other/vol-0c41d2", params: { reason: "x" } }).failureReason!, /target not found/);
  for (const r of [attached]) assert.deepEqual([r.changes, r.estimatedDurationSec], [[], 20]);
});

test("apply accumulates effects for the sequential dry run of the gate", () => {
  const block: ValidatedStep = { actionType: "block_image_tag", target: "image/orders-api:3.8.0", params: {} };
  const w1 = infra.apply(w0, rollback);
  assert.deepEqual(infra.dryRun(w1, rollback).failureReason, "deployment/orders-api already runs v3.7.2");
  const w2 = infra.apply(w1, block);
  assert.deepEqual(w2.deployments["orders-api"]!.blockedTags, ["3.8.0"]);
  assert.match(infra.dryRun(w2, block).failureReason!, /is already blocked/);
  assert.deepEqual(w0.deployments["orders-api"]!.blockedTags, []); // efeito puro
  const note = infra.apply(w0, { actionType: "add_incident_note", target: "incident/orders-api", params: { text: "rollback pedido" } });
  assert.deepEqual(note.notes, ["rollback pedido"]);
  // Só ações reversíveis revertem.
  const noRevert = infra.revert(note, gated({ actionType: "add_incident_note", target: "incident/orders-api", params: { text: "x" } }, "succeeded"));
  assert.deepEqual([noRevert.result.ok, noRevert.world], [false, note]);
  assert.deepEqual(infra.revert(w2, gated(block, "succeeded")).world.deployments["orders-api"]!.blockedTags, []);
});

test("cost actions lower the projected monthly cost by the finding savings", () => {
  const steps: ValidatedStep[] = [
    { actionType: "tag_resource_for_review", target: "volume/data-platform/vol-0c41d2", params: { reason: "idle" } },
    { actionType: "create_volume_snapshot", target: "volume/data-platform/vol-0c41d2", params: {} },
    { actionType: "delete_volume", target: "volume/data-platform/vol-0c41d2", params: {} },
    { actionType: "release_elastic_ip", target: "ip/data-platform/eipalloc-0f19", params: {} },
    { actionType: "resize_instance", target: "instance/data-platform/i-07ab3", params: { toType: "r6i.large" } },
  ];
  const before = projectedMonthlyCostUsd(costWorld.inventory!, prices);
  assert.equal(before, 696.53);
  assert.deepEqual(infra.postActionSignals(costWorld, cost).metrics, { projected_monthly_cost_usd: [696.53] });
  let w = costWorld;
  for (const step of steps) {
    const r = infra.execute(w, step, cost);
    assert.equal(r.result.ok, true, step.actionType);
    w = r.world;
  }
  const after = projectedMonthlyCostUsd(w.inventory!, prices);
  const expected = auditInventory(cost.inventory!, prices).totalMonthlySavingsUsd;
  assert.equal(expected, 339.59);
  assert.equal(Math.round((before - after) * 100) / 100, expected);
  assert.ok(infra.postActionSignals(w, cost).metrics.projected_monthly_cost_usd![0]! <= 600);
  const savings = steps.map((s) => infra.monthlySavingsFor(gated(s, "succeeded"), w));
  assert.deepEqual(savings, [0, 0, 60, 3.65, 275.94]);
  assert.equal(Math.round(savings.reduce((a, x) => a + x, 0) * 100) / 100, expected);
  assert.equal(infra.monthlySavingsFor(gated(rollback, "succeeded"), w0), 0);
  assert.deepEqual(w.snapshots, ["volume/data-platform/vol-0c41d2"]);
  assert.deepEqual(w.tagsForReview, ["volume/data-platform/vol-0c41d2"]);
  // Reverter o resize volta ao tipo original do inventário inicial.
  const resize = steps[4]!;
  const back = infra.revert(w, gated(resize, "succeeded")).world;
  assert.equal(back.inventory!.instances.find((i) => i.id === "i-07ab3")!.type, "r6i.2xlarge");
});

test("fault injection makes execute fail without changing the world", () => {
  const faulty = repo((s) => ({ ...s, file: { ...s.file, faults: { "rollback_deployment@deployment/orders-api": "fail" } } })).get("deploy-5xx-rollback");
  const r = infra.execute(w0, rollback, faulty);
  assert.equal(r.result.ok, false);
  assert.match(r.result.summary, /failure injected/);
  assert.equal(r.world, w0);
  // Dry run que passou no portão pode falhar na execução se o mundo mudou.
  const moved = infra.apply(w0, rollback);
  const again = infra.execute(moved, rollback, deploy);
  assert.deepEqual([again.result.ok, again.result.summary], [false, "deployment/orders-api already runs v3.7.2"]);
});
