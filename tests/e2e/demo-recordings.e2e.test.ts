// Gravações da War Room geradas em memória (spec 5.2, 7.6 e 10.2; AC-39): schema, tamanho, prefixo comum e determinismo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemoRecordingSchema, ScenarioSummarySchema } from "../../src/contracts/index.ts";
import { recordScenario } from "../../src/app/demo-recorder.ts";
import { runCli } from "../helpers/spawn.ts";

for (const id of ["deploy-5xx-rollback", "cost-anomaly"]) {
  test(`recording for ${id} is valid, small and shares the prefix`, async () => {
    const rec = await recordScenario(id);
    assert.equal(DemoRecordingSchema.safeParse(rec).success, true);
    assert.ok(Buffer.byteLength(JSON.stringify(rec)) <= 300 * 1024);
    assert.equal(rec.label, "Reprodução de execução gravada com provedor fake roteirizado");
    assert.ok(!("appVersion" in rec.recordedWith));
    assert.equal(rec.recordedWith.provider, "fake");
    assert.equal(rec.scenario.id, id);
    assert.ok(rec.branches);
    const lastCommon = rec.common.events.at(-1)!.seq;
    assert.ok(rec.branches.approved.events[0]!.seq > lastCommon);
    assert.ok(rec.branches.rejected.events[0]!.seq > lastCommon);
    assert.equal(rec.common.incident.incident.status, "awaiting_approval");
    assert.ok(rec.common.approvals.length > 0 && rec.common.approvals.every((a) => a.status === "pending"));
    assert.equal(rec.common.postmortem, null);
    assert.equal(rec.branches.approved.incident.incident.status, "resolved");
    assert.equal(rec.branches.rejected.incident.incident.status, "escalated");
    assert.ok(rec.branches.approved.approvals.every((a) => a.status === "approved"));
    assert.ok(rec.branches.rejected.approvals.every((a) => a.status === "rejected"));
    assert.equal(rec.branches.approved.postmortem!.status, "final");
    assert.equal(rec.branches.rejected.postmortem!.status, "partial");
    assert.ok(rec.branches.approved.metrics);
    // A auditoria do ramo continua a cadeia do prefixo comum.
    assert.ok(rec.branches.approved.audit.length > 0);
    assert.ok(!rec.branches.approved.audit.some((e) => rec.common.audit.some((c) => c.id === e.id)));
    assert.deepEqual((await recordScenario(id)).common, rec.common); // determinístico
  });
}

test("record-demo writes index.json and one file per scenario", async () => {
  const out = mkdtempSync(join(tmpdir(), "ic-rec-"));
  const r = await runCli(["record-demo", "--out", out]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readdirSync(out).sort(), ["cost-anomaly.json", "deploy-5xx-rollback.json", "index.json"]);
  const index = JSON.parse(readFileSync(join(out, "index.json"), "utf8"));
  assert.equal(ScenarioSummarySchema.array().safeParse(index).success, true);
  assert.equal(index.length, 2);
  for (const f of ["cost-anomaly.json", "deploy-5xx-rollback.json"]) {
    assert.equal(DemoRecordingSchema.safeParse(JSON.parse(readFileSync(join(out, f), "utf8"))).success, true, f);
    assert.match(r.stdout, new RegExp(f.replace(".", "\\.")));
  }
  assert.match(r.stdout, /KB/);
});
