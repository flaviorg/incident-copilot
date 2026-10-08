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

// Revisão final: os pontos de entrada só rodam dentro de `if (import.meta.main)`, que só existe a partir do Node 24.2.
// Num Node 24.0 ou 24.1, check:secrets e check:tokens passariam calados (código 0, sem varrer nada). A versão fica
// presa em dois lugares: .nvmrc (nvm e CI) e engine-strict (npm ci recusa um Node abaixo de engines).
test("the Node version is pinned where tools read it", () => {
  const minor = (v: string) => v.trim().replace(/^>=\s*v?/, "").split(".").slice(0, 2).map(Number);
  const engines = (JSON.parse(readFileSync("package.json", "utf8")) as { engines: { node: string } }).engines.node;
  const [eMajor, eMinor] = minor(engines);
  const [nMajor, nMinor] = minor(readFileSync(".nvmrc", "utf8"));
  assert.ok(Number.isInteger(nMajor) && Number.isInteger(nMinor), ".nvmrc precisa de major.minor");
  assert.ok(nMajor! > eMajor! || (nMajor === eMajor && nMinor! >= eMinor!), `.nvmrc abaixo de engines (${engines})`);
  assert.match(existsSync(".npmrc") ? readFileSync(".npmrc", "utf8") : "", /^engine-strict=true$/m);
  const [pMajor, pMinor] = minor(process.versions.node);
  assert.ok(pMajor! > eMajor! || (pMajor === eMajor && pMinor! >= eMinor!), `Node ${process.versions.node} abaixo de engines`);
});
