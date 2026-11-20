import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ScenarioRepository } from "../../src/infra/scenarios/scenario-loader.ts";
import type { LoadedScenario } from "../../src/infra/scenarios/scenario-loader.ts";
import { createToolRegistry, truncateSummary } from "../../src/tools/registry.ts";
import type { ToolContext } from "../../src/tools/registry.ts";
import { formatMetric, formatNumber } from "../../src/tools/format.ts";
import type { WorldState } from "../../src/contracts/index.ts";
import { SimulatedInfra } from "../../src/infra/simulated-infra.ts";

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
/** Initial world of the scenario, the same one the container uses. */
const worldOf = (s: LoadedScenario): WorldState => new SimulatedInfra({ prices: readJson("data/cloud-prices.json") }).initialWorld(s);

const scenarios = new ScenarioRepository({ rootDir: "fixtures/scenarios" });
const reg = createToolRegistry({ prices: readJson("data/cloud-prices.json") });
const ctxOf = (s: LoadedScenario, now: string): ToolContext => ({ incident: { kind: "scenario", scenario: s }, world: worldOf(s), now: new Date(now) });
const ctxDeploy = () => ctxOf(scenarios.get("deploy-5xx-rollback"), "2026-10-04T09:43:10Z");

test("registry lists the 4 read tools", async () => assert.deepEqual((await reg.names(ctxDeploy())).sort(), ["audit_cloud_inventory", "list_deploys", "query_logs", "query_metrics"]));
test("query_metrics summarizes the 5xx spike", async () => {
  const r = await reg.run("query_metrics", { service: "orders-api", metric: "http_5xx_rate", window: "30m" }, ctxDeploy());
  assert.equal(r.ok, true); assert.match(r.summary, /peak/); assert.ok(r.summary.length <= 600);
  assert.match(r.evidenceRef!, /^metrics:orders-api:http_5xx_rate@/);
});
test("invalid args and unknown tools are observations, not exceptions", async () => {
  const bad = await reg.run("query_metrics", { service: "orders-api", metric: "cpu", window: "30m" }, ctxDeploy());
  assert.equal(bad.ok, false); assert.match(bad.summary, /^invalid arguments/); assert.match(bad.summary, /metric/);
  const unk = await reg.run("kubectl_exec", {}, ctxDeploy());
  assert.equal(unk.ok, false); assert.match(unk.summary, /^unknown tool: kubectl_exec/);
  assert.equal((await reg.run("query_metrics", null, ctxDeploy())).ok, false);
  // A live-only tool does not exist in a scenario.
  assert.match((await reg.run("query_errors", { service: "orders-api", window: "15m" }, ctxDeploy())).summary, /^unknown tool: query_errors/);
});
test("query_logs shows the grouped error with its version", async () => {
  const r = await reg.run("query_logs", { service: "orders-api", level: "ERROR", window: "15m" }, ctxDeploy());
  assert.match(r.summary, /380/); assert.match(r.summary, /PriceFormatter\.format/); assert.match(r.summary, /v3\.8\.0/);
});
test("list_deploys shows the suspect deploy", async () => assert.match((await reg.run("list_deploys", { service: "orders-api" }, ctxDeploy())).summary, /v3\.8\.0.*v3\.7\.2/s));
test("audit_cloud_inventory totals 339.59", async () => {
  const s = scenarios.get("cost-anomaly");
  assert.match((await reg.run("audit_cloud_inventory", { account: "data-platform" }, ctxOf(s, "2026-10-04T08:00:00Z"))).summary, /339\.59/);
});
test("unknown service and truncation", async () => {
  assert.equal((await reg.run("query_metrics", { service: "payments-api", metric: "http_5xx_rate", window: "30m" }, ctxDeploy())).ok, false);
  const t = truncateSummary("x".repeat(700)); assert.ok(t.length <= 600); assert.ok(t.endsWith(" (truncated)"));
});
test("describeForPrompt lists every tool with its JSON Schema", async () => {
  const text = await reg.describeForPrompt(ctxDeploy());
  for (const n of await reg.names(ctxDeploy())) assert.match(text, new RegExp(n));
  assert.match(text, /"window"/);
});
// AC-54: the scenario prompt input stays byte-identical, so the fake's token estimates and the goldens do not move.
test("scenario tool description equals the frozen copy byte for byte", async () => {
  const frozen = readFileSync("tests/fixtures/tools/scenario-tools-description.txt", "utf8");
  assert.equal(await reg.describeForPrompt(ctxDeploy()), frozen);
  assert.equal(await reg.describeForPrompt(ctxOf(scenarios.get("cost-anomaly"), "2026-10-04T08:00:00Z")), frozen);
});
test("en-US number formatting", () => {
  assert.equal(formatNumber(339.59), "339.59"); assert.equal(formatNumber(1240, 0), "1240");
  assert.equal(formatMetric("http_5xx_rate", 0.096), "9.6%"); assert.equal(formatMetric("daily_cost_usd", 23.1), "US$ 23.10");
});
