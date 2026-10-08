import { test } from "node:test";
import assert from "node:assert/strict";
import { auditInventory, roundUsd } from "../../src/domain/finops/inventory-audit.ts";
import type { Inventory } from "../../src/contracts/index.ts";

// Inventário e preços de teste escritos à mão, com valores esperados literais (calculados à mão).
const prices = { version: "t", note: "t", hoursPerMonth: 730, volumeGbMonthUsd: { gp3: 0.08 }, publicIpv4HourUsd: 0.005, instanceHourUsd: { "r6i.large": 0.126, "r6i.xlarge": 0.252 } };
const inv: Inventory = { account: "acme", region: "us-east-1",
  volumes: [{ id: "vol-1", type: "gp3", sizeGb: 100, attachedTo: null, unattachedDays: 9 }, { id: "vol-2", type: "gp3", sizeGb: 40, attachedTo: "i-2", unattachedDays: 0 }],
  publicIps: [{ id: "eip-1", associatedWith: null }],
  instances: [{ id: "i-1", type: "r6i.xlarge", avgCpuPct14d: 4, role: "batch" }, { id: "i-2", type: "r6i.xlarge", avgCpuPct14d: 60, role: "db" }],
  backupVaults: [{ id: "bkp/acme", monthlyCostUsd: 20, oldestRecoveryPointDays: 300 }] };

test("finds zombies and oversized instances with literal savings", () => {
  const r = auditInventory(inv, prices);
  assert.deepEqual(r.findings.map((f) => [f.kind, f.resourceId, f.monthlySavingsUsd]),
    [["unattached_volume", "vol-1", 8], ["unassociated_ip", "eip-1", 3.65], ["oversized_instance", "i-1", 91.98]]);
  assert.equal(r.totalMonthlySavingsUsd, 103.63);
  assert.deepEqual(r.findings[2]!.recommendation, { actionType: "resize_instance", params: { toType: "r6i.large" } });
  assert.deepEqual(r.findings.map((f) => f.target), ["volume/acme/vol-1", "ip/acme/eip-1", "instance/acme/i-1"]);
});
test("backup vaults are never findings", () => assert.ok(auditInventory(inv, prices).findings.every((f) => !f.resourceId.startsWith("bkp"))));
test("roundUsd keeps two decimals", () => { assert.equal(roundUsd(275.94000000000005), 275.94); assert.equal(roundUsd(3.6500000000000004), 3.65); });
