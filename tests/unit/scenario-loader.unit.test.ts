import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScenarioRepository } from "../../src/infra/scenarios/scenario-loader.ts";
import { firstViolation } from "../../src/domain/telemetry/series.ts";
import { NotFoundError, ValidationError } from "../../src/domain/errors.ts";
import { SimulatedClock, SystemClock } from "../../src/infra/clock.ts";

const repo = new ScenarioRepository({ rootDir: "fixtures/scenarios" });

test("lists both scenarios", () => assert.deepEqual(repo.list().map((s) => s.id), ["cost-anomaly", "deploy-5xx-rollback"]));

test("deploy impact starts at 09:40:30 and peaks near 10%", () => {
  const s = repo.get("deploy-5xx-rollback");
  assert.equal(firstViolation(s.series.http_5xx_rate!, 0.05), "2026-10-04T09:40:30.000Z");
  const peak = Math.max(...s.series.http_5xx_rate!.map((p) => p.value));
  assert.ok(peak > 0.095 && peak <= 0.1, String(peak));
  assert.equal(s.deploys.at(-1)!.version, "v3.8.0");
  assert.equal(s.alert.service, "orders-api"); assert.equal(s.alert.severity, "sev1");
  assert.ok(s.logs.some((l) => l.level === "ERROR" && l.count === 380));
  assert.notEqual(s.after, null);
});

test("cost scenario has inventory and no service", () => {
  const s = repo.get("cost-anomaly");
  assert.equal(s.alert.service, null); assert.equal(s.alert.account, "data-platform");
  assert.equal(s.inventory!.volumes.length, 2); assert.deepEqual(s.deploys, []); assert.equal(s.after, null);
  assert.equal(s.series.daily_cost_usd!.length, 7 * 24 + 1);
});

test("offset shifts every timestamp", () => {
  const s = repo.get("deploy-5xx-rollback", { offsetSec: 3600 });
  assert.equal(s.alert.detectedAt, "2026-10-04T10:42:30.000Z");
  assert.equal(s.deploys.at(-1)!.at, "2026-10-04T10:40:00.000Z");
  assert.equal(firstViolation(s.series.http_5xx_rate!, 0.05), "2026-10-04T10:40:30.000Z");
  assert.equal(s.offsetSec, 3600);
  // o cache não mistura deslocamentos
  assert.equal(repo.get("deploy-5xx-rollback").alert.detectedAt, "2026-10-04T09:42:30.000Z");
});

test("unknown scenario", () => {
  assert.throws(() => repo.get("nope"), (e) => e instanceof NotFoundError && e.code === "scenario_not_found");
  assert.throws(() => repo.get("../fixtures"), (e) => e instanceof NotFoundError && e.code === "scenario_not_found");
  // A mensagem só repete um id bem formado; o resto (caminho, aspas, texto enorme) não volta para quem chamou.
  assert.throws(() => repo.get("nope"), { message: "scenario not found: nope" });
  assert.throws(() => repo.get("../fixtures"), { message: "scenario not found (id out of format)" });
  assert.throws(() => repo.get("x".repeat(65)), { message: "scenario not found (id out of format)" });
});

test("invalid scenario file names the file and the field", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ic-scn-"));
  try {
    mkdirSync(join(tmp, "broken"));
    writeFileSync(join(tmp, "broken", "scenario.json"), JSON.stringify({
      id: "broken", title: "t", summary: "s", service: "x", account: null, severity: "sev2", expectedCategory: "unknown",
      canary: [{ metric: "http_5xx_rate", op: "<=", threshold: 0.05 }], demo: { approvalLatencySec: 0 },
    }));
    writeFileSync(join(tmp, "broken", "signals.json"), JSON.stringify({ start: "2026-10-04T00:00:00.000Z", durationSec: 60, resolutionSec: 30, series: {} }));
    assert.throws(() => new ScenarioRepository({ rootDir: tmp }).get("broken"),
      (e) => e instanceof ValidationError && /scenario\.json/.test(e.message) && /alert/.test(e.message));
    writeFileSync(join(tmp, "broken", "scenario.json"), "{ not json");
    assert.throws(() => new ScenarioRepository({ rootDir: tmp }).get("broken"),
      (e) => e instanceof ValidationError && /scenario\.json/.test(e.message));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("transform is applied", () => {
  const r = new ScenarioRepository({ rootDir: "fixtures/scenarios", transform: (s) => ({ ...s, summary: { ...s.summary, title: "replaced title" } }) });
  assert.equal(r.get("deploy-5xx-rollback").summary.title, "replaced title");
});

test("SimulatedClock ticks and aligns; SystemClock does not tick", () => {
  const c = new SimulatedClock(new Date("2026-10-04T00:00:00Z"));
  const d = new Date("2026-10-04T09:42:30.000Z");
  assert.equal(c.alignTo(d).toISOString(), d.toISOString());
  c.tick(20);
  assert.equal(c.now().toISOString(), "2026-10-04T09:42:50.000Z");
  const sys = new SystemClock();
  const before = Date.now(); sys.tick(3600); const after = sys.now().getTime();
  assert.ok(after - before < 60_000);
  assert.ok(Math.abs(sys.alignTo(d).getTime() - Date.now()) < 60_000);
});
