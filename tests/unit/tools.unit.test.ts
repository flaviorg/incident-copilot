import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ScenarioRepository } from "../../src/infra/scenarios/scenario-loader.ts";
import type { LoadedScenario } from "../../src/infra/scenarios/scenario-loader.ts";
import { createToolRegistry, truncateSummary } from "../../src/tools/registry.ts";
import { formatMetric, formatNumber } from "../../src/tools/format.ts";
import type { WorldState } from "../../src/contracts/index.ts";
import { SimulatedInfra } from "../../src/infra/simulated-infra.ts";

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
/** Mundo inicial do cenário, o mesmo que o container usa. */
const worldOf = (s: LoadedScenario): WorldState => new SimulatedInfra({ prices: readJson("data/cloud-prices.json") }).initialWorld(s);

const scenarios = new ScenarioRepository({ rootDir: "fixtures/scenarios" });
const reg = createToolRegistry({ prices: readJson("data/cloud-prices.json") });
const ctxDeploy = () => { const s = scenarios.get("deploy-5xx-rollback"); return { scenario: s, world: worldOf(s), now: new Date("2026-10-04T09:43:10Z") }; };

test("registry lists the 4 read tools", () => assert.deepEqual(reg.names().sort(), ["audit_cloud_inventory", "list_deploys", "query_logs", "query_metrics"]));
test("query_metrics summarizes the 5xx spike", () => {
  const r = reg.run("query_metrics", { service: "orders-api", metric: "http_5xx_rate", window: "30m" }, ctxDeploy());
  assert.equal(r.ok, true); assert.match(r.summary, /peak/); assert.ok(r.summary.length <= 600);
  assert.match(r.evidenceRef!, /^metrics:orders-api:http_5xx_rate@/);
});
test("invalid args and unknown tools are observations, not exceptions", () => {
  const bad = reg.run("query_metrics", { service: "orders-api", metric: "cpu", window: "30m" }, ctxDeploy());
  assert.equal(bad.ok, false); assert.match(bad.summary, /^invalid arguments/); assert.match(bad.summary, /metric/);
  const unk = reg.run("kubectl_exec", {}, ctxDeploy());
  assert.equal(unk.ok, false); assert.match(unk.summary, /^unknown tool: kubectl_exec/);
  assert.equal(reg.run("query_metrics", null, ctxDeploy()).ok, false);
});
test("query_logs shows the grouped error with its version", () => {
  const r = reg.run("query_logs", { service: "orders-api", level: "ERROR", window: "15m" }, ctxDeploy());
  assert.match(r.summary, /380/); assert.match(r.summary, /PriceFormatter\.format/); assert.match(r.summary, /v3\.8\.0/);
});
test("list_deploys shows the suspect deploy", () => assert.match(reg.run("list_deploys", { service: "orders-api" }, ctxDeploy()).summary, /v3\.8\.0.*v3\.7\.2/s));
test("audit_cloud_inventory totals 339.59", () => {
  const s = scenarios.get("cost-anomaly");
  assert.match(reg.run("audit_cloud_inventory", { account: "data-platform" }, { scenario: s, world: worldOf(s), now: new Date("2026-10-04T08:00:00Z") }).summary, /339\.59/);
});
test("unknown service and truncation", () => {
  assert.equal(reg.run("query_metrics", { service: "payments-api", metric: "http_5xx_rate", window: "30m" }, ctxDeploy()).ok, false);
  const t = truncateSummary("x".repeat(700)); assert.ok(t.length <= 600); assert.ok(t.endsWith(" (truncated)"));
});
test("describeForPrompt lists every tool with its JSON Schema", () => {
  const text = reg.describeForPrompt();
  for (const n of reg.names()) assert.match(text, new RegExp(n));
  assert.match(text, /"window"/);
});
test("en-US number formatting", () => {
  assert.equal(formatNumber(339.59), "339.59"); assert.equal(formatNumber(1240, 0), "1240");
  assert.equal(formatMetric("http_5xx_rate", 0.096), "9.6%"); assert.equal(formatMetric("daily_cost_usd", 23.1), "US$ 23.10");
});
