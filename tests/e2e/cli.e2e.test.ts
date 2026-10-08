import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_ROOT, runCli } from "../helpers/spawn.ts";

const FAKE_KEY = "sk-or-v1-" + "a".repeat(40);
/** Caminho do post-mortem impresso pela demo, a partir da raiz do projeto. */
const reportPath = (stdout: string) => {
  const m = /post-mortem: (\S+)/.exec(stdout);
  assert.ok(m, "the demo did not print the post-mortem path");
  return join(PROJECT_ROOT, m[1]!);
};

test("scenarios lists both ids", async () => { const r = await runCli(["scenarios"]); assert.equal(r.code, 0); assert.match(r.stdout, /deploy-5xx-rollback/); assert.match(r.stdout, /cost-anomaly/); });
test("tool audit_cloud_inventory prints the potential savings", async () =>
  assert.match((await runCli(["tool", "audit_cloud_inventory", "--scenario", "cost-anomaly", "--args", '{"account":"data-platform"}'])).stdout, /339\.59/));
test("tool query_metrics prints the spike", async () =>
  assert.match((await runCli(["tool", "query_metrics", "--scenario", "deploy-5xx-rollback", "--args", '{"service":"orders-api","metric":"http_5xx_rate","window":"30m"}'])).stdout, /peak/));
test("unknown command exits 1 with usage", async () => { const r = await runCli(["nope"]); assert.equal(r.code, 1); assert.match(r.stderr, /usage:/i); });
test("tool errors are short messages without stack traces", async () => {
  const unknownScenario = await runCli(["tool", "query_metrics", "--scenario", "nope", "--args", "{}"]);
  assert.equal(unknownScenario.code, 1); assert.match(unknownScenario.stderr, /scenario not found/); assert.doesNotMatch(unknownScenario.stderr, /\n\s+at /);
  const badJson = await runCli(["tool", "query_metrics", "--scenario", "deploy-5xx-rollback", "--args", "{nope"]);
  assert.equal(badJson.code, 1); assert.match(badJson.stderr, /--args/);
});

test("demo runs offline with fake provider even with a key in the environment", async () => {
  const r = await runCli(["demo"], { OPENROUTER_API_KEY: FAKE_KEY, APPROVAL_TOKEN: "cli-token-ABCDEFGHIJKLMNOP" });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.ms < 10_000, `${r.ms} ms`);
  for (const s of ["provider: scripted fake", "awaiting APR-0001", "demo operator approved APR-0001 (token verified, value omitted)", "healthy canary", "MTTR", "illustrative"]) assert.ok(r.stdout.includes(s), s);
  assert.ok(!r.stdout.includes("cli-token-ABCDEFGHIJKLMNOP"));
  assert.ok(!r.stderr.includes("cli-token-ABCDEFGHIJKLMNOP"));
  assert.ok(!r.stdout.includes(FAKE_KEY));
  const report = readFileSync(reportPath(r.stdout), "utf8");
  assert.ok(!report.includes("cli-token-ABCDEFGHIJKLMNOP"));
  assert.match(report, /^# /);
  assert.match(r.stdout, /MTTR\s+11\.2 min/);
  assert.match(r.stdout, /awaiting approval\s+3\.0 min/);
  assert.match(r.stdout, /outcome: resolved/);
});

test("demo --reject ends escalated with exit 0", async () => {
  const r = await runCli(["demo", "--reject"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /demo operator rejected APR-0001 \(token verified, value omitted\)/);
  assert.match(r.stdout, /mitigation_rejected/);
});

test("demo cost-anomaly shows the blocked forbidden step and the savings", async () => {
  const r = await runCli(["demo", "--scenario", "cost-anomaly"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /delete_backups.*tier 4.*blocked/);
  assert.match(r.stdout, /339\.59/);
});

test("demo --json prints only the result object", async () => {
  const r = await runCli(["demo", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { incident: { incident: { status: string } }; metrics: { mttrMin: number }; postmortemPath: string };
  assert.equal(out.incident.incident.status, "resolved");
  assert.ok(Math.abs(out.metrics.mttrMin - 11.18) < 0.05);
  assert.match(out.postmortemPath, /^reports\/INC-0001-postmortem\.md$/);
});

test("demo --persist twice continues the id sequence", async () => {
  const DB_PATH = join(mkdtempSync(join(tmpdir(), "ic-")), "demo.db");
  const first = await runCli(["demo", "--persist"], { DB_PATH });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /INC-0001/);
  const second = await runCli(["demo", "--persist"], { DB_PATH });
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /INC-0002/);
  assert.match(second.stdout, /awaiting APR-0002/);
});

test("demo rejects unknown options and scenarios with short errors", async () => {
  const bad = await runCli(["demo", "--nope"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /usage:/);
  const unknown = await runCli(["demo", "--scenario", "nope"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /scenario not found/);
  assert.doesNotMatch(unknown.stderr, /\n\s+at /);
});

test("demo --live without an OpenRouter key fails instead of falling back to the fake", async () => {
  const r = await runCli(["demo", "--live"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--live requires OPENROUTER_API_KEY and OPENROUTER_MODEL/);
  assert.doesNotMatch(r.stdout, /provider: scripted fake/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
  const forcedFake = await runCli(["demo", "--live"], { LLM_PROVIDER: "fake", OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_MODEL: "x/y" });
  assert.equal(forcedFake.code, 1);
  assert.match(forcedFake.stderr, /--live requires/);
  assert.ok(!forcedFake.stderr.includes(FAKE_KEY));
});

test("demo piped into a reader that closes early (like `| head`) exits 0 without a stack trace", async () => {
  const { spawn } = await import("node:child_process");
  const { CHILD_NODE_ARGS } = await import("../helpers/spawn.ts");
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...CHILD_NODE_ARGS, "src/cli.ts", "demo"], {
      cwd: PROJECT_ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    child.stdout.once("data", () => child.stdout.destroy());
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
  assert.doesNotMatch(result.stderr, /EPIPE|\n\s+at /);
  assert.equal(result.code, 0);
});
