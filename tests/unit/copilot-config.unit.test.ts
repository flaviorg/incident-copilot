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
import { defineNotifier } from "../../src/notifiers/types.ts";
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
