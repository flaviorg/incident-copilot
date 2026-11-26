// copilot.yaml (spec 008, decisions 6, 10 and 12; AC-51, AC-52 and AC-55): zod-validated, ${VAR} interpolation, secrets
// only as whole references, problems as { path, rule } without values, and the fake-provider guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import { assertLiveSafe, loadCopilotConfigFile, parseCopilotConfig } from "../../src/infra/copilot-config/load.ts";
import { defineConnector } from "../../src/connectors/types.ts";
import { DEFAULT_NOTIFICATION_EVENTS, NOTIFICATION_KINDS, defineNotifier } from "../../src/notifiers/types.ts";
import { webhookAuthSchema } from "../../src/connectors/shared/auth.ts";
import { CopilotConfigError } from "../../src/domain/errors.ts";
import { loadConfig } from "../../src/config.ts";

const TOKEN = "tok-" + "a".repeat(28);
const QUERY_TOKEN = "qry-" + "b".repeat(28);
const HOOK = "https://hooks.example.com/" + "c".repeat(20);
const env = { HOOK_TOKEN: TOKEN, QUERY_TOKEN, ORG: "acme", SHORT: "short", HOOK_URL: HOOK };
const ENV_VALUES = [TOKEN, QUERY_TOKEN, "acme", "short", HOOK];

const pinger = defineConnector({
  type: "pinger", displayName: "Pinger", capabilities: ["ingest", "query"],
  configSchema: (h) => z.strictObject({
    ingest: z.strictObject({ auth: webhookAuthSchema(h, ["bearer", "basic"]) }).optional(),
    query: z.strictObject({ baseUrl: h.url(), org: h.text(), token: h.secret() }).optional(),
  }),
  create: (_c, d) => ({ id: d.id, type: "pinger", ingest: null, query: null }),
});
const reader = defineConnector({
  type: "reader", displayName: "Reader", capabilities: ["query"],
  configSchema: () => z.strictObject({}),
  create: (_c, d) => ({ id: d.id, type: "reader", ingest: null, query: {} }),
});
const chat = defineNotifier({
  type: "chat",
  configSchema: (h) => z.strictObject({ webhookUrl: h.secret() }),
  create: (_c, d) => ({ id: d.id, type: "chat", send: async () => ({ ok: true }) }),
});
const opts = (o: Partial<Parameters<typeof parseCopilotConfig>[1]> = {}) => ({ format: "yaml" as const, env, connectors: [pinger, reader], notifiers: [chat], ...o });

const YAML_OK = `
# comments are the reason for YAML
version: 1
mode: shadow
publicUrl: https://copilot.example.com/
ingest: { rateLimitPerMin: 30 }
services:
  - name: checkout-api
    aliases: { prom: [checkout] }
connectors:
  - id: prom
    type: pinger
    severityMap: { critical: sev1 }
    ingest: { auth: { type: bearer, token: "\${HOOK_TOKEN}" } }
    query: { baseUrl: "https://api.example.com/\${ORG}", org: "\${ORG}-prod", token: "\${QUERY_TOKEN}" }
  - id: data
    type: reader
    enabled: false
notifiers:
  - id: team
    type: chat
    webhookUrl: "\${HOOK_URL}"
    events: [analysis_ready]
`;

const problemsOf = (text: string, o = opts()) => {
  const r = parseCopilotConfig(text, o);
  assert.equal(r.ok, false, "expected problems");
  return r.ok ? [] : r.problems;
};
const noValues = (problems: unknown) => {
  const t = JSON.stringify(problems);
  for (const v of ENV_VALUES) assert.ok(!t.includes(v), `a value leaked into the problems: ${t}`);
};

test("valid YAML parses with defaults, interpolation and the secrets collected", () => {
  const r = parseCopilotConfig(YAML_OK, opts());
  assert.ok(r.ok, JSON.stringify(!r.ok && r.problems));
  const c = r.config;
  assert.equal(c.version, 1);
  assert.equal(c.mode, "shadow");
  assert.equal(c.publicUrl, "https://copilot.example.com");
  assert.deepEqual(c.ingest, { maxBodyBytes: 1_048_576, rateLimitPerMin: 30, maxQueued: 100, dedupeWindowMin: 1440, trustProxy: false });
  assert.deepEqual(c.services, [{ name: "checkout-api", aliases: { prom: ["checkout"] } }]);
  assert.deepEqual(c.connectors.map((e) => [e.id, e.type, e.enabled, e.severityMap]), [["prom", "pinger", true, { critical: "sev1" }], ["data", "reader", false, null]]);
  assert.deepEqual(c.connectors[0]!.capabilities, ["ingest", "query"]);
  const cfg = c.connectors[0]!.config as { ingest: { auth: { token: string } }; query: { baseUrl: string; org: string } };
  assert.equal(cfg.ingest.auth.token, TOKEN);
  assert.equal(cfg.query.baseUrl, "https://api.example.com/acme");
  assert.equal(cfg.query.org, "acme-prod");
  assert.deepEqual(c.notifiers.map((n) => [n.id, n.type, n.events]), [["team", "chat", ["analysis_ready"]]]);
  assert.deepEqual([...c.secrets].sort(), [HOOK, QUERY_TOKEN, TOKEN].sort());
});

test("JSON is accepted with the same schema; the minimal file has every default", () => {
  const r = parseCopilotConfig(JSON.stringify({ version: 1 }), opts({ format: "json" }));
  assert.ok(r.ok);
  assert.deepEqual([r.config.mode, r.config.publicUrl, r.config.connectors, r.config.notifiers, r.config.services, r.config.secrets], ["shadow", null, [], [], [], []]);
  const n = parseCopilotConfig(JSON.stringify({ version: 1, notifiers: [{ id: "team", type: "chat", webhookUrl: "${HOOK_URL}" }] }), opts({ format: "json" }));
  assert.ok(n.ok);
  assert.deepEqual(n.config.notifiers[0]!.events, ["incident_opened", "analysis_ready", "run_failed", "incident_resolved"]);
  assert.deepEqual(problemsOf("{ nope", opts({ format: "json" })), [{ path: "", rule: "invalid JSON" }]);
});

test("YAML syntax errors and duplicate keys give a line, never the text", () => {
  assert.deepEqual(problemsOf("version: 1\nconnectors: [a, b\nmode: x\n"), [{ path: "line 3", rule: "invalid YAML" }]);
  assert.deepEqual(problemsOf("version: 1\nversion: 1\n"), [{ path: "line 2", rule: "invalid YAML" }]);
  assert.deepEqual(problemsOf("- just\n- a list\n"), [{ path: "", rule: "must be object" }]);
});

test("an unset variable, a literal secret and a short secret are problems without values", () => {
  const unset = problemsOf(YAML_OK, opts({ env: { ...env, ORG: undefined as unknown as string } }));
  assert.deepEqual(unset.map((p) => p.path), ["connectors[0].query.baseUrl", "connectors[0].query.org"]);
  assert.ok(unset.every((p) => p.rule === "environment variable ORG is not set"));
  const literal = problemsOf(YAML_OK.replace('"${HOOK_TOKEN}"', `"${TOKEN}"`));
  assert.deepEqual(literal, [{ path: "connectors[0].ingest.auth.token", rule: "secrets must be a whole ${VAR} reference" }]);
  const partial = problemsOf(YAML_OK.replace('"${HOOK_TOKEN}"', '"Bearer ${HOOK_TOKEN}"'));
  assert.deepEqual(partial.map((p) => p.rule), ["secrets must be a whole ${VAR} reference"]);
  const short = problemsOf(YAML_OK.replace("${HOOK_TOKEN}", "${SHORT}"));
  assert.deepEqual(short, [{ path: "connectors[0].ingest.auth.token", rule: "environment variable SHORT must hold at least 16 characters" }]);
  noValues([unset, literal, partial, short]);
});

test("unknown keys, unknown types, duplicate ids, bad aliases and other modes are refused", () => {
  const unknownKey = problemsOf(YAML_OK.replace("mode: shadow", "mode: shadow\ncolor: blue"));
  assert.deepEqual(unknownKey, [{ path: "", rule: "unknown key color" }]);
  const nested = problemsOf(YAML_OK.replace("ingest: { auth:", "ingest: { extra: 1, auth:"));
  assert.deepEqual(nested, [{ path: "connectors[0].ingest", rule: "unknown key extra" }]);
  const unknownType = problemsOf(YAML_OK.replace("type: reader", "type: nagios"));
  assert.deepEqual(unknownType, [{ path: "connectors[1].type", rule: "unknown connector type; known: pinger, reader" }]);
  const dup = problemsOf(YAML_OK.replace("id: data", "id: prom"));
  assert.deepEqual(dup, [{ path: "connectors[1].id", rule: "duplicate connector id" }]);
  const alias = problemsOf(YAML_OK.replace("aliases: { prom: [checkout] }", "aliases: { grafana: [checkout] }"));
  assert.deepEqual(alias, [{ path: "services[0].aliases.grafana", rule: "alias keys must be connector ids" }]);
  const mode = problemsOf(YAML_OK.replace("mode: shadow", "mode: supervised"));
  assert.deepEqual(mode, [{ path: "mode", rule: "only shadow is supported in 0.4" }]);
  const authType = problemsOf(YAML_OK.replace("type: bearer", "type: hmac"));
  assert.deepEqual(authType.map((p) => p.path), ["connectors[0].ingest.auth.type"]);
  const range = problemsOf(YAML_OK.replace("rateLimitPerMin: 30", "rateLimitPerMin: 0"));
  assert.deepEqual(range, [{ path: "ingest.rateLimitPerMin", rule: "out of range" }]);
  const badId = problemsOf(YAML_OK.replace("id: prom", "id: Prom_1"));
  assert.deepEqual(badId.map((p) => p.path), ["connectors[0].id", "services[0].aliases.prom"]);
  const notifier = problemsOf(YAML_OK.replace("type: chat", "type: pager").replace("events: [analysis_ready]", "events: [analysis_ready, paged]"));
  assert.deepEqual(notifier.map((p) => p.path).sort(), ["notifiers[0].events[1]", "notifiers[0].type"].sort());
  const version = problemsOf(YAML_OK.replace("version: 1", "version: 2"));
  assert.deepEqual(version, [{ path: "version", rule: "must be one of: 1" }]);
  noValues([unknownKey, nested, unknownType, dup, alias, mode, authType, range, badId, notifier, version]);
});

test("URL helper refuses plain http off loopback and credentials in the URL", () => {
  const http = problemsOf(YAML_OK.replace("https://api.example.com/${ORG}", "http://api.example.com"));
  assert.deepEqual(http, [{ path: "connectors[0].query.baseUrl", rule: "must be an https URL (http only for loopback hosts)" }]);
  assert.ok(parseCopilotConfig(YAML_OK.replace("https://api.example.com/${ORG}", "http://127.0.0.1:9090"), opts()).ok);
  const creds = problemsOf(YAML_OK.replace("https://api.example.com/${ORG}", "https://user:pw@api.example.com"));
  assert.deepEqual(creds.map((p) => p.rule), ["URLs must not carry credentials"]);
});

test("loadCopilotConfigFile picks the format by extension and reports read errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "ic-cfg-"));
  try {
    writeFileSync(join(dir, "copilot.yaml"), YAML_OK);
    writeFileSync(join(dir, "copilot.json"), JSON.stringify({ version: 1 }));
    writeFileSync(join(dir, "copilot.toml"), "version = 1");
    const o = { env, connectors: [pinger, reader], notifiers: [chat] };
    assert.equal(loadCopilotConfigFile(join(dir, "copilot.yaml"), o).ok, true);
    assert.equal(loadCopilotConfigFile(join(dir, "copilot.json"), o).ok, true);
    assert.deepEqual(loadCopilotConfigFile(join(dir, "copilot.toml"), o), { ok: false, problems: [{ path: "", rule: "the config file must end in .yaml, .yml or .json" }] });
    assert.deepEqual(loadCopilotConfigFile(join(dir, "missing.yaml"), o), { ok: false, problems: [{ path: "", rule: "cannot read the config file" }] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ingest.trustProxy: false, a hop count or proxy addresses; plain true is refused because X-Forwarded-For is client-controlled", () => {
  const withProxy = (v: string) => parseCopilotConfig(`version: 1\ningest: { trustProxy: ${v} }\n`, opts());
  for (const [text, expected] of [["false", false], ["1", 1], ["2", 2], ['["10.0.0.0/8", "192.0.2.7", "2001:db8::1"]', ["10.0.0.0/8", "192.0.2.7", "2001:db8::1"]]] as const) {
    const r = withProxy(text);
    assert.ok(r.ok, `${text}: ${JSON.stringify(!r.ok && r.problems)}`);
    assert.deepEqual(r.config.ingest.trustProxy, expected);
  }
  for (const bad of ["true", "0", "11", "1.5", "[]", '["not an address"]', '["10.0.0.1; drop"]', '"yes"']) {
    const r = withProxy(bad);
    assert.equal(r.ok, false, bad);
    assert.deepEqual(!r.ok && r.problems.map((p) => p.path), ["ingest.trustProxy"], bad);
    assert.ok(!r.ok && /X-Forwarded-For/.test(r.problems[0]!.rule));
  }
});

test("assertLiveSafe refuses enabled ingest connectors with the fake provider", () => {
  const r = parseCopilotConfig(YAML_OK, opts());
  assert.ok(r.ok);
  const fake = loadConfig({ LLM_PROVIDER: "fake" });
  const live = loadConfig({ LLM_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-v1-" + "a".repeat(40), OPENROUTER_MODEL: "m/x" });
  assert.throws(() => assertLiveSafe(fake, r.config), (e) => e instanceof CopilotConfigError && e.problems[0]!.rule.includes("LLM_PROVIDER=openrouter"));
  assert.doesNotThrow(() => assertLiveSafe(live, r.config));
  assert.doesNotThrow(() => assertLiveSafe(fake, null));
  const queryOnly = { ...r.config, connectors: r.config.connectors.map((c) => (c.type === "pinger" ? { ...c, enabled: false } : c)) };
  assert.doesNotThrow(() => assertLiveSafe(fake, queryOnly));
});

test("assertLiveSafe looks at the entry, not the definition: a query-only entry of an ingest-capable type is allowed", () => {
  const text = `
version: 1
connectors:
  - id: errors
    type: pinger
    query: { baseUrl: "https://api.example.com/\${ORG}", org: "\${ORG}-prod", token: "\${QUERY_TOKEN}" }
`;
  const r = parseCopilotConfig(text, opts());
  assert.ok(r.ok, JSON.stringify(!r.ok && r.problems));
  assert.deepEqual(r.config.connectors[0]!.capabilities, ["ingest", "query"], "the definition declares ingest");
  const fake = loadConfig({ LLM_PROVIDER: "fake" });
  assert.doesNotThrow(() => assertLiveSafe(fake, r.config), "but the entry has no ingest block");
  const withIngest = parseCopilotConfig(text.replace("    query:", '    ingest: { auth: { type: bearer, token: "${HOOK_TOKEN}" } }\n    query:'), opts());
  assert.ok(withIngest.ok, JSON.stringify(!withIngest.ok && withIngest.problems));
  assert.throws(() => assertLiveSafe(fake, withIngest.config), CopilotConfigError);
});

// ---- codeFix (spec 009, decisions 7, 10, 16, 19 and 20; AC-84 and AC-52) ----

const FIX_TOKEN = "ghp-" + "f".repeat(36);
const fixEnv = { ...env, GITHUB_FIX_TOKEN: FIX_TOKEN };
const errorsConnector = defineConnector({
  type: "sentry", displayName: "Sentry (test)", capabilities: ["query"],
  configSchema: () => z.strictObject({}),
  create: (_c, d) => ({ id: d.id, type: "sentry", ingest: null, query: {} }),
});
const fixOpts = (o: Partial<Parameters<typeof parseCopilotConfig>[1]> = {}) => opts({ env: fixEnv, connectors: [pinger, reader, errorsConnector], ...o });

const repoEntry = (over: Record<string, unknown> = {}) => ({
  repo: "acme/checkout-web", service: "checkout-web", connector: "errors", baseBranch: "main",
  pathPrefixes: ["/app/", "app:///", "webpack:///./"], sourceGlobs: ["src/**/*.{js,ts}"], testGlobs: ["tests/**/*.test.{js,ts}"],
  testFiles: ["tests/**/*.test.js"], ...over,
});
const fixDoc = (codeFix: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => JSON.stringify({
  version: 1,
  services: [{ name: "checkout-web" }, { name: "billing-api" }],
  connectors: [{ id: "errors", type: "sentry" }, { id: "data", type: "reader" }],
  ...(codeFix === undefined ? {} : { codeFix }),
  ...extra,
});
const parseFix = (codeFix: Record<string, unknown> | undefined, o = fixOpts({ format: "json" })) => parseCopilotConfig(fixDoc(codeFix), o);
const fixProblems = (codeFix: Record<string, unknown>) => {
  const r = parseFix(codeFix);
  assert.equal(r.ok, false, "expected problems");
  const problems = r.ok ? [] : r.problems;
  const t = JSON.stringify(problems);
  assert.ok(!t.includes(FIX_TOKEN), `the token leaked into the problems: ${t}`);
  return problems;
};

test("codeFix: absent gives null; a minimal block parses with every default", () => {
  const none = parseFix(undefined);
  assert.ok(none.ok, JSON.stringify(!none.ok && none.problems));
  assert.equal(none.config.codeFix, null);
  const r = parseFix({ repositories: [repoEntry()] });
  assert.ok(r.ok, JSON.stringify(!r.ok && r.problems));
  const c = r.config.codeFix!;
  assert.equal(c.enabled, true);
  assert.equal(c.mode, "shadow");
  assert.equal(c.approvalTtlHours, 72);
  assert.deepEqual(c.sandbox, { network: "isolated" });
  assert.deepEqual(c.github, { apiUrl: "https://api.github.com", token: null });
  assert.deepEqual(c.commitAuthor, { name: "incident-copilot", email: "incident-copilot@example.invalid" });
  assert.deepEqual(c.limits, {
    maxConcurrent: 1, maxFiles: 3, maxSourceLines: 20, maxTotalLines: 50, maxTestLines: 40, maxEdits: 2, maxAuthorAttempts: 2,
    maxLlmCalls: 6, maxTokens: 60_000, attemptTimeoutMin: 15, testTimeoutSec: 120, maxOutputBytes: 65_536, maxAttemptsPerDay: 5, maxAttemptsPerGroup: 3,
  });
  assert.deepEqual(c.fixableExceptionTypes, ["TypeError", "RangeError", "ReferenceError"]);
  assert.deepEqual(c.repositories, [{ ...repoEntry(), deniedPaths: [] }]);
  assert.deepEqual(r.config.secrets, []);
});

test("codeFix: the full YAML block from the spec parses; the token is a secret joined to the redaction list", () => {
  const text = `
version: 1
services: [{ name: checkout-web }]
connectors: [{ id: sentry, type: sentry }]
codeFix:
  enabled: true
  mode: draft_pr
  approvalTtlHours: 168
  sandbox: { network: best_effort }
  github:
    apiUrl: https://api.github.com
    token: \${GITHUB_FIX_TOKEN}
  commitAuthor: { name: incident-copilot, email: incident-copilot@example.invalid }
  limits: { maxConcurrent: 2, maxFiles: 2 }
  fixableExceptionTypes: [TypeError]
  repositories:
    - repo: acme/checkout-web
      service: checkout-web
      connector: sentry
      baseBranch: release/2026.11
      pathPrefixes: ["/app/"]
      sourceGlobs: ["src/**/*.{js,ts}"]
      testGlobs: ["tests/**/*.test.{js,ts}"]
      testFiles: ["tests/**/*.test.js"]
      deniedPaths: ["src/pricing/**"]
`;
  const r = parseCopilotConfig(text, fixOpts());
  assert.ok(r.ok, JSON.stringify(!r.ok && r.problems));
  const c = r.config.codeFix!;
  assert.equal(c.mode, "draft_pr");
  assert.equal(c.sandbox.network, "best_effort");
  assert.equal(c.github.token, FIX_TOKEN);
  assert.equal(c.limits.maxConcurrent, 2);
  assert.equal(c.limits.maxFiles, 2);
  assert.equal(c.limits.maxSourceLines, 20);
  assert.equal(c.repositories[0]!.baseBranch, "release/2026.11");
  assert.ok(r.config.secrets.includes(FIX_TOKEN));
});

test("codeFix: each limit at its ceiling passes, one above fails, one below its floor fails", async () => {
  const { CODE_FIX_CEILINGS, CODE_FIX_FLOORS } = await import("../../src/domain/code-fix/limits.ts");
  for (const [key, ceiling] of Object.entries(CODE_FIX_CEILINGS)) {
    const at = parseFix({ limits: { [key]: ceiling }, repositories: [repoEntry()] });
    assert.ok(at.ok, `${key} at ${ceiling}: ${JSON.stringify(!at.ok && at.problems)}`);
    assert.equal((at.config.codeFix!.limits as Record<string, number>)[key], ceiling);
    assert.deepEqual(fixProblems({ limits: { [key]: ceiling + 1 }, repositories: [repoEntry()] }), [{ path: `codeFix.limits.${key}`, rule: "out of range" }], key);
    const floor = (CODE_FIX_FLOORS as Record<string, number>)[key]!;
    assert.deepEqual(fixProblems({ limits: { [key]: floor - 1 }, repositories: [repoEntry()] }), [{ path: `codeFix.limits.${key}`, rule: "out of range" }], key);
  }
  assert.deepEqual(fixProblems({ limits: { maxFiles: 2.5 }, repositories: [repoEntry()] }).map((p) => p.path), ["codeFix.limits.maxFiles"]);
  assert.deepEqual(fixProblems({ limits: { maxRetries: 1 }, repositories: [repoEntry()] }), [{ path: "codeFix.limits", rule: "unknown key maxRetries" }]);
  assert.deepEqual(fixProblems({ approvalTtlHours: 169, repositories: [repoEntry()] }), [{ path: "codeFix.approvalTtlHours", rule: "out of range" }]);
});

test("codeFix: strict objects, enums and the sandbox network default", () => {
  assert.deepEqual(fixProblems({ color: "blue", repositories: [repoEntry()] }), [{ path: "codeFix", rule: "unknown key color" }]);
  assert.deepEqual(fixProblems({ repositories: [repoEntry({ extra: 1 })] }), [{ path: "codeFix.repositories[0]", rule: "unknown key extra" }]);
  assert.deepEqual(fixProblems({ mode: "auto_merge", repositories: [repoEntry()] }), [{ path: "codeFix.mode", rule: "must be one of: shadow, draft_pr" }]);
  assert.deepEqual(fixProblems({ sandbox: { network: "open" }, repositories: [repoEntry()] }), [{ path: "codeFix.sandbox.network", rule: "must be one of: isolated, best_effort" }]);
  const empty = parseFix({ sandbox: {}, repositories: [repoEntry()] });
  assert.ok(empty.ok);
  assert.equal(empty.config.codeFix!.sandbox.network, "isolated");
  assert.deepEqual(fixProblems({ github: { apiUrl: "http://api.github.com" }, repositories: [repoEntry()] }), [{ path: "codeFix.github.apiUrl", rule: "must be an https URL (http only for loopback hosts)" }]);
  assert.deepEqual(fixProblems({ repositories: [] }), [{ path: "codeFix.repositories", rule: "out of range" }]);
  assert.deepEqual(fixProblems({ repositories: Array.from({ length: 21 }, (_, i) => repoEntry({ repo: `acme/r${i}` })) }).map((p) => p.path), ["codeFix.repositories"]);
  assert.deepEqual(fixProblems({ fixableExceptionTypes: ["Type Error"], repositories: [repoEntry()] }).map((p) => p.path), ["codeFix.fixableExceptionTypes[0]"]);
});

// The GitHub client refuses an apiUrl with a query or a fragment at startup, so the loader must refuse it first:
// a config that `config check` accepts must never crash `npm start`.
test("codeFix: github.apiUrl with a query or a fragment is refused with a fixed rule", () => {
  const rule = [{ path: "codeFix.github.apiUrl", rule: "must not have a query or a fragment" }];
  assert.deepEqual(fixProblems({ github: { apiUrl: "https://ghe.example.com/api/v3?x=1" }, repositories: [repoEntry()] }), rule);
  assert.deepEqual(fixProblems({ github: { apiUrl: "https://ghe.example.com/api/v3#top" }, repositories: [repoEntry()] }), rule);
  assert.deepEqual(fixProblems({ github: { apiUrl: "https://ghe.example.com/api/v3?" }, repositories: [repoEntry()] }), rule);
  const ok = parseFix({ github: { apiUrl: "https://ghe.example.com/api/v3" }, repositories: [repoEntry()] });
  assert.ok(ok.ok);
  assert.equal(ok.config.codeFix!.github.apiUrl, "https://ghe.example.com/api/v3");
});

test("codeFix: testFiles is required and non-empty", () => {
  const { testFiles: _omit, ...withoutTestFiles } = repoEntry();
  assert.deepEqual(fixProblems({ repositories: [withoutTestFiles] }), [{ path: "codeFix.repositories[0].testFiles", rule: "must be array" }]);
  assert.deepEqual(fixProblems({ repositories: [repoEntry({ testFiles: [] })] }), [{ path: "codeFix.repositories[0].testFiles", rule: "out of range" }]);
});

test("codeFix: the token must be a whole ${GITHUB_FIX_TOKEN} reference and is never echoed", () => {
  assert.deepEqual(fixProblems({ github: { token: FIX_TOKEN }, repositories: [repoEntry()] }), [{ path: "codeFix.github.token", rule: "secrets must be a whole ${VAR} reference" }]);
  assert.deepEqual(fixProblems({ github: { token: "Bearer ${GITHUB_FIX_TOKEN}" }, repositories: [repoEntry()] }), [{ path: "codeFix.github.token", rule: "secrets must be a whole ${VAR} reference" }]);
  const unset = parseFix({ github: { token: "${GITHUB_FIX_TOKEN}" }, repositories: [repoEntry()] }, fixOpts({ format: "json", env }));
  assert.deepEqual(!unset.ok && unset.problems, [{ path: "codeFix.github.token", rule: "environment variable GITHUB_FIX_TOKEN is not set" }]);
  const ok = parseFix({ github: { token: "${GITHUB_FIX_TOKEN}" }, repositories: [repoEntry()] });
  assert.ok(ok.ok);
  assert.deepEqual(ok.config.secrets, [FIX_TOKEN]);
});

test("codeFix cross-checks: services, connectors, repositories, ref names, globs and the draft_pr token", () => {
  const one = (r: Record<string, unknown>) => fixProblems({ repositories: [repoEntry(r)] });
  assert.deepEqual(one({ service: "nope" }), [{ path: "codeFix.repositories[0].service", rule: "unknown service; must be a services[].name" }]);
  assert.deepEqual(fixProblems({ repositories: [repoEntry(), repoEntry({ repo: "acme/other" })] }), [{ path: "codeFix.repositories[1].service", rule: "duplicate service; one repository per service" }]);
  assert.deepEqual(one({ connector: "nope" }), [{ path: "codeFix.repositories[0].connector", rule: "unknown connector id" }]);
  assert.deepEqual(one({ connector: "data" }), [{ path: "codeFix.repositories[0].connector", rule: "must be a connector of type sentry" }]);
  assert.deepEqual(fixProblems({ repositories: [repoEntry(), repoEntry({ repo: "ACME/checkout-web", service: "billing-api" })] }), [{ path: "codeFix.repositories[1].repo", rule: "duplicate repository" }]);
  for (const repo of ["acme", "acme/a/b", "acme/a b", "/acme", "acme/", `acme/${"x".repeat(101)}`, "acme/$(id)"]) {
    assert.deepEqual(one({ repo }), [{ path: "codeFix.repositories[0].repo", rule: "must be owner/name (letters, digits, '_', '.' or '-', at most 100 each)" }], repo);
  }
  for (const baseBranch of ["-main", "main..x", "main.lock", "a//b", "main/", "/main", "ma in", "main@{1}", "ma~in", "ma:in", "main.", ".main", "ma\\in", "x".repeat(201)]) {
    assert.deepEqual(one({ baseBranch }), [{ path: "codeFix.repositories[0].baseBranch", rule: "must be a valid branch name" }], baseBranch);
  }
  const GLOB_RULE = "globs may use only letters, digits and _ . / * { } , -, with no leading '-' or '/' and no '..'";
  for (const field of ["sourceGlobs", "testGlobs", "testFiles", "deniedPaths"]) {
    for (const glob of ["-x/**", "/etc/**", "../x/*.js", "src/../x.js", "src/**/*.js;rm", "src/[a].js", "src/ x.js"]) {
      assert.deepEqual(one({ [field]: [glob] }), [{ path: `codeFix.repositories[0].${field}[0]`, rule: GLOB_RULE }], `${field}: ${glob}`);
    }
  }
  assert.deepEqual(fixProblems({ mode: "draft_pr", repositories: [repoEntry()] }), [{ path: "codeFix.github.token", rule: "required when mode is draft_pr" }]);
  assert.ok(parseFix({ mode: "draft_pr", github: { token: "${GITHUB_FIX_TOKEN}" }, repositories: [repoEntry()] }).ok);
  // Every problem is collected at once.
  assert.equal(fixProblems({ mode: "draft_pr", repositories: [repoEntry({ service: "nope", connector: "nope" })] }).length, 3);
});

test("assertLiveSafe refuses codeFix draft_pr without APPROVAL_TOKEN or a GitHub token, with any provider", () => {
  const live = loadConfig({ LLM_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-v1-" + "a".repeat(40), OPENROUTER_MODEL: "m/x" });
  const withApproval = { ...live, approvalToken: "appr-" + "z".repeat(30) };
  const draft = parseFix({ mode: "draft_pr", github: { token: "${GITHUB_FIX_TOKEN}" }, repositories: [repoEntry()] });
  assert.ok(draft.ok);
  assert.throws(() => assertLiveSafe({ ...live, approvalToken: null }, draft.config), (e) =>
    e instanceof CopilotConfigError && e.problems.some((p) => p.path === "codeFix.mode" && p.rule.includes("APPROVAL_TOKEN")));
  assert.doesNotThrow(() => assertLiveSafe(withApproval, draft.config));
  const noToken = { ...draft.config, codeFix: { ...draft.config.codeFix!, github: { ...draft.config.codeFix!.github, token: null } } };
  assert.throws(() => assertLiveSafe(withApproval, noToken), (e) => e instanceof CopilotConfigError && e.problems.some((p) => p.path === "codeFix.github.token"));
  const disabled = { ...draft.config, codeFix: { ...draft.config.codeFix!, enabled: false } };
  assert.doesNotThrow(() => assertLiveSafe({ ...live, approvalToken: null }, disabled));
  const shadow = parseFix({ repositories: [repoEntry()] });
  assert.ok(shadow.ok);
  assert.doesNotThrow(() => assertLiveSafe({ ...live, approvalToken: null }, shadow.config));
  const fake = loadConfig({ LLM_PROVIDER: "fake" });
  assert.throws(() => assertLiveSafe({ ...fake, approvalToken: null }, draft.config), CopilotConfigError);
});

test("notifier events: the default stays the four 0.4 kinds; the two code-fix kinds are opt-in (AC-83)", () => {
  const parse = (events: unknown) => parseCopilotConfig(JSON.stringify({ version: 1, notifiers: [{ id: "team", type: "chat", webhookUrl: "${HOOK_URL}", ...(events === undefined ? {} : { events }) }] }), opts({ format: "json" }));
  const def = parse(undefined);
  assert.ok(def.ok);
  assert.deepEqual(def.config.notifiers[0]!.events, ["incident_opened", "analysis_ready", "run_failed", "incident_resolved"]);
  assert.deepEqual([...DEFAULT_NOTIFICATION_EVENTS], ["incident_opened", "analysis_ready", "run_failed", "incident_resolved"]);
  const opted = parse(["code_fix_ready", "code_fix_pr_opened"]);
  assert.ok(opted.ok, JSON.stringify(!opted.ok && opted.problems));
  assert.deepEqual(opted.config.notifiers[0]!.events, ["code_fix_ready", "code_fix_pr_opened"]);
  const all = parse([...NOTIFICATION_KINDS]);
  assert.ok(all.ok, JSON.stringify(!all.ok && all.problems));
  assert.equal(all.config.notifiers[0]!.events.length, 6);
  const tooMany = parse([...NOTIFICATION_KINDS, "analysis_ready"]);
  assert.equal(tooMany.ok, false);
  assert.ok(!tooMany.ok && tooMany.problems.some((p) => p.path === "notifiers[0].events"));
  const unknown = parse(["code_fix_merged"]);
  assert.ok(!unknown.ok && unknown.problems.some((p) => p.path === "notifiers[0].events[0]"));
});
