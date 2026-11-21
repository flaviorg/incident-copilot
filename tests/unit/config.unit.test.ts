import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig, ConfigError } from "../../src/config.ts";

test("defaults", () => {
  const c = loadConfig({});
  assert.equal(c.llmProvider, "fake");
  assert.equal(c.dbPath, "./data/incident-copilot.db");
  assert.equal(c.host, "127.0.0.1"); assert.equal(c.port, 3000);
  assert.equal(c.runTimeoutMs, 180000); assert.equal(c.llmTimeoutMs, 30000);
  assert.equal(c.llmBaseUrl, "https://openrouter.ai/api/v1");
  assert.equal(c.approvalToken, null); assert.equal(c.approvalTtlMin, 30);
  assert.equal(c.actionRateLimitPerMin, 5); assert.equal(c.actionRepeatWindowMin, 10);
  assert.equal(c.circuitFailureThreshold, 3); assert.equal(c.circuitCooldownSec, 300);
  assert.equal(c.clock, "system"); assert.equal(c.logLevel, "info");
  assert.equal(c.copilotConfigPath, null);
});
test("COPILOT_CONFIG is a path; blank means scenario mode only", () => {
  assert.equal(loadConfig({ COPILOT_CONFIG: "./copilot.yaml" }).copilotConfigPath, "./copilot.yaml");
  assert.equal(loadConfig({ COPILOT_CONFIG: "   " }).copilotConfigPath, null);
});
test("autodetects openrouter when a key exists and LLM_PROVIDER is unset", () => {
  assert.equal(loadConfig({ OPENROUTER_API_KEY: "sk-or-v1-abc", OPENROUTER_MODEL: "m" }).llmProvider, "openrouter");
});
test("LLM_PROVIDER=fake and forceFake win over the key", () => {
  assert.equal(loadConfig({ LLM_PROVIDER: "fake", OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "m" }).llmProvider, "fake");
  assert.equal(loadConfig({ OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "m" }, { forceFake: true }).llmProvider, "fake");
});
test("fails early for openrouter without model or key", () => {
  assert.throws(() => loadConfig({ LLM_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k" }), /OPENROUTER_MODEL/);
  assert.throws(() => loadConfig({ LLM_PROVIDER: "openrouter", OPENROUTER_MODEL: "m" }), /OPENROUTER_API_KEY/);
});
test("short APPROVAL_TOKEN fails without echoing the value", () => {
  assert.throws(() => loadConfig({ APPROVAL_TOKEN: "short-secret" }),
    (e) => e instanceof ConfigError && /APPROVAL_TOKEN/.test(e.message) && !e.message.includes("short-secret"));
});
test("invalid numbers fail and empty strings count as unset", () => {
  assert.throws(() => loadConfig({ PORT: "abc" }), /PORT/);
  assert.equal(loadConfig({ APPROVAL_TOKEN: "" }).approvalToken, null);
});

// Final review: the entry points only run inside `if (import.meta.main)`, which exists only from Node 24.2 on.
// On Node 24.0 or 24.1, check:secrets and check:tokens would pass silently (code 0, scanning nothing). The version is
// pinned in two places: .nvmrc (nvm and CI) and engine-strict (npm ci refuses a Node below engines).
test("the Node version is pinned where tools read it", () => {
  const minor = (v: string) => v.trim().replace(/^>=\s*v?/, "").split(".").slice(0, 2).map(Number);
  const engines = (JSON.parse(readFileSync("package.json", "utf8")) as { engines: { node: string } }).engines.node;
  const [eMajor, eMinor] = minor(engines);
  const [nMajor, nMinor] = minor(readFileSync(".nvmrc", "utf8"));
  assert.ok(Number.isInteger(nMajor) && Number.isInteger(nMinor), ".nvmrc needs major.minor");
  assert.ok(nMajor! > eMajor! || (nMajor === eMajor && nMinor! >= eMinor!), `.nvmrc below engines (${engines})`);
  assert.match(existsSync(".npmrc") ? readFileSync(".npmrc", "utf8") : "", /^engine-strict=true$/m);
  const [pMajor, pMinor] = minor(process.versions.node);
  assert.ok(pMajor! > eMajor! || (pMajor === eMajor && pMinor! >= eMinor!), `Node ${process.versions.node} below engines`);
});

// Review 2026-11: Host allowlist and run concurrency cap.
test("ALLOWED_HOSTS and MAX_CONCURRENT_RUNS", () => {
  const d = loadConfig({});
  assert.deepEqual(d.allowedHosts, []); assert.equal(d.maxConcurrentRuns, 2);
  const c = loadConfig({ ALLOWED_HOSTS: " Box.local:3000 , api.test ", MAX_CONCURRENT_RUNS: "4" });
  assert.deepEqual(c.allowedHosts, ["box.local:3000", "api.test"]); assert.equal(c.maxConcurrentRuns, 4);
  assert.throws(() => loadConfig({ MAX_CONCURRENT_RUNS: "0" }), (e) => e instanceof ConfigError && /MAX_CONCURRENT_RUNS/.test(e.message));
});

// Review 2026-11 follow-up: an API token is required whenever the API listens beyond loopback.
test("API_TOKEN: optional on loopback, required on a non-loopback HOST, never echoed", async () => {
  const { assertApiExposureSafe, isLoopbackHost } = await import("../../src/config.ts");
  assert.equal(loadConfig({}).apiToken, null);
  for (const h of ["127.0.0.1", "localhost", "::1", "[::1]"]) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ["0.0.0.0", "::", "10.0.0.5", "box.local"]) assert.equal(isLoopbackHost(h), false, h);
  assert.doesNotThrow(() => assertApiExposureSafe(loadConfig({})));
  assert.throws(() => assertApiExposureSafe(loadConfig({ HOST: "0.0.0.0" })), (e) => e instanceof ConfigError && /API_TOKEN/.test(e.message));
  const token = "api-token-" + "x".repeat(20);
  const c = loadConfig({ HOST: "0.0.0.0", API_TOKEN: token });
  assert.equal(c.apiToken, token);
  assert.doesNotThrow(() => assertApiExposureSafe(c));
  assert.throws(() => loadConfig({ API_TOKEN: "short-one" }), (e) => e instanceof ConfigError && /API_TOKEN/.test(e.message) && !e.message.includes("short-one"));
  assert.throws(() => loadConfig({ API_TOKEN: token, APPROVAL_TOKEN: token }), (e) => e instanceof ConfigError && /API_TOKEN/.test(e.message));
});
