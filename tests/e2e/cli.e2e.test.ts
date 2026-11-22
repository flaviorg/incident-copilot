import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_ROOT, runCli } from "../helpers/spawn.ts";

const FAKE_KEY = "sk-or-v1-" + "a".repeat(40);
/** Path of the post-mortem printed by the demo, from the project root. */
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

// Spec 008 (AC-51 and AC-52): config check validates copilot.yaml and never prints a value.
test("config check prints a summary for a valid copilot.yaml and redacts its secrets", async () => {
  const { writeFileSync, rmSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "ic-cli-cfg-"));
  const token = "am-cli-" + "r".repeat(30);
  try {
    const file = join(dir, "copilot.yaml");
    writeFileSync(file, [
      "version: 1",
      "publicUrl: https://copilot.example.com",
      "services:",
      "  - name: checkout-api",
      "    aliases: { prom: [checkout] }",
      "connectors:",
      "  - id: prom",
      "    type: alertmanager",
      "    ingest: { auth: { type: bearer, token: \"${AM_TOKEN}\" } }",
      "  - id: old",
      "    type: alertmanager",
      "    enabled: false",
    ].join("\n"));
    const ok = await runCli(["config", "check", "--file", file], { AM_TOKEN: token });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /^copilot config OK: /);
    assert.match(ok.stdout, /mode: shadow/);
    assert.match(ok.stdout, /publicUrl: https:\/\/copilot\.example\.com/);
    assert.match(ok.stdout, /- prom \(alertmanager\): capabilities ingest; ingest path \/ingest\/prom/);
    assert.match(ok.stdout, /- old \(alertmanager\): disabled/);
    assert.match(ok.stdout, /notifiers: 0/);
    assert.match(ok.stdout, /services: 1/);
    assert.ok(!ok.stdout.includes(token) && !ok.stderr.includes(token));

    // COPILOT_CONFIG is the default file.
    const viaEnv = await runCli(["config", "check"], { AM_TOKEN: token, COPILOT_CONFIG: file });
    assert.equal(viaEnv.code, 0, viaEnv.stderr);

    // Invalid: a literal secret, an unset variable and an unknown key; no value in the output.
    const bad = join(dir, "bad.yaml");
    writeFileSync(bad, [
      "version: 1",
      "colour: blue",
      "connectors:",
      "  - id: prom",
      "    type: alertmanager",
      `    ingest: { auth: { type: bearer, token: "${token}" } }`,
      "  - id: two",
      "    type: alertmanager",
      "    ingest: { auth: { type: basic, username: am, password: \"${UNSET_PASSWORD}\" } }",
    ].join("\n"));
    const r = await runCli(["config", "check", "--file", bad], { AM_TOKEN: token });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^copilot config invalid: 1 problem\(s\)/);
    assert.match(r.stderr, /- \(file\): unknown key colour/);
    const r2 = await runCli(["config", "check", "--file", bad.replace("bad", "bad2")], {});
    assert.equal(r2.code, 1);
    assert.match(r2.stderr, /cannot read the config file/);
    writeFileSync(bad, readFileSync(bad, "utf8").replace("colour: blue\n", ""));
    const r3 = await runCli(["config", "check", "--file", bad], { AM_TOKEN: token });
    assert.equal(r3.code, 1);
    assert.match(r3.stderr, /- connectors\[0\]\.ingest\.auth\.token: secrets must be a whole \$\{VAR\} reference/);
    assert.match(r3.stderr, /- connectors\[1\]\.ingest\.auth\.password: environment variable UNSET_PASSWORD is not set/);
    for (const out of [r.stdout, r.stderr, r3.stdout, r3.stderr]) assert.ok(!out.includes(token));
    const usage = await runCli(["config", "lint"]);
    assert.equal(usage.code, 1);
    assert.match(usage.stderr, /config check/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// copilot.example.yaml at the repository root must stay valid: every connector and notifier type, secrets as ${VAR}.
test("config check accepts copilot.example.yaml when its variables are set", async () => {
  const fill = (prefix: string, n: number) => prefix + "x".repeat(n);
  const env: Record<string, string> = {
    ALERTMANAGER_WEBHOOK_TOKEN: fill("am-", 30),
    NEW_RELIC_WEBHOOK_TOKEN: fill("nr-hook-", 30),
    NEW_RELIC_API_KEY: fill("NRAK-", 27),
    SENTRY_CLIENT_SECRET: fill("", 64),
    SENTRY_AUTH_TOKEN: fill("sentry-", 40),
    BUGSNAG_WEBHOOK_TOKEN: fill("bugsnag_", 32),
    BUGSNAG_AUTH_TOKEN: fill("bugsnag-", 40),
    GENERIC_WEBHOOK_SECRET: fill("generic-", 32),
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/" + fill("T0/B0/", 24),
    OUTBOUND_WEBHOOK_SIGNING_SECRET: fill("sign-", 32),
    OUTBOUND_WEBHOOK_TOKEN: fill("out-", 32),
    // A fine-grained PAT shape, built at run time (AGENTS.md): the codeFix block references it (spec 009).
    GITHUB_FIX_TOKEN: "github_pat_" + "A1b2".repeat(20),
  };
  const r = await runCli(["config", "check", "--file", "copilot.example.yaml"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^copilot config OK: copilot\.example\.yaml/);
  for (const type of ["alertmanager", "newrelic", "sentry", "bugsnag", "webhook", "mcp", "slack", "outbound-webhook"]) {
    assert.match(r.stdout, new RegExp(`\\(${type}\\)`), type);
  }
  for (const value of Object.values(env)) assert.ok(!r.stdout.includes(value) && !r.stderr.includes(value));
});

// Spec 009 (AC-84): the example declares a shadow-mode codeFix block whose token is a whole ${GITHUB_FIX_TOKEN} secret,
// so leaving that variable unset is a { path, rule } problem with no value echoed.
test("config check refuses copilot.example.yaml without GITHUB_FIX_TOKEN", async () => {
  const fill = (prefix: string, n: number) => prefix + "x".repeat(n);
  const env: Record<string, string> = {
    ALERTMANAGER_WEBHOOK_TOKEN: fill("am-", 30),
    NEW_RELIC_WEBHOOK_TOKEN: fill("nr-hook-", 30),
    NEW_RELIC_API_KEY: fill("NRAK-", 27),
    SENTRY_CLIENT_SECRET: fill("", 64),
    SENTRY_AUTH_TOKEN: fill("sentry-", 40),
    BUGSNAG_WEBHOOK_TOKEN: fill("bugsnag_", 32),
    BUGSNAG_AUTH_TOKEN: fill("bugsnag-", 40),
    GENERIC_WEBHOOK_SECRET: fill("generic-", 32),
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/" + fill("T0/B0/", 24),
    OUTBOUND_WEBHOOK_SIGNING_SECRET: fill("sign-", 32),
    OUTBOUND_WEBHOOK_TOKEN: fill("out-", 32),
  };
  const r = await runCli(["config", "check", "--file", "copilot.example.yaml"], env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^- codeFix\.github\.token: /m);
  for (const value of Object.values(env)) assert.ok(!r.stdout.includes(value) && !r.stderr.includes(value));
});
