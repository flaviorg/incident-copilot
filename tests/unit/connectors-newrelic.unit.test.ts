// New Relic connector, ingest side and config (spec 008; docs/connectors/newrelic.md): the shared conformance kit plus
// the field mapping of the documented workflow webhook template. Fixtures are built from the docs, not captured.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { newRelicConnector } from "../../src/connectors/newrelic/index.ts";
import { createConnectorInstance } from "../../src/connectors/registry.ts";
import { createHttpClient } from "../../src/connectors/shared/http.ts";
import { parseCopilotConfig } from "../../src/infra/copilot-config/load.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { describeConnectorConformance } from "../helpers/connector-conformance.ts";
import { createFakeFetch } from "../helpers/fake-fetch.ts";
import { inboundRequest, INBOUND_RECEIVED_AT, withHeaders } from "../helpers/inbound.ts";

const TOKEN = "nr-webhook-" + "q".repeat(24);
const API_KEY = "NRAK-" + "A1b2C3d4".repeat(5);
const DIR = "tests/fixtures/connectors/newrelic";
const ACTIVATED = `${DIR}/issue-activated.json`;
const CLOSED = `${DIR}/issue-closed.json`;
const UNKNOWN = `${DIR}/issue-unknown-state.json`;
const GRAPHQL_ERROR = `${DIR}/nerdgraph-graphql-error.json`;
const TIMESERIES = `${DIR}/nerdgraph-timeseries.json`;
const ENDPOINT = "https://api.newrelic.com/graphql";
const read = (f: string) => JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;

const QUERY_ENTRY = { region: "us", accountId: 1234567, apiKey: "${NR_API_KEY}" };
const window = { from: new Date("2026-10-04T09:30:00.000Z"), to: new Date("2026-10-04T10:00:00.000Z") };

describeConnectorConformance(newRelicConnector, {
  env: { NR_TOKEN: TOKEN, NR_API_KEY: API_KEY },
  entry: { ingest: { auth: { type: "bearer", token: "${NR_TOKEN}" } }, query: QUERY_ENTRY },
  secrets: [TOKEN, API_KEY],
  withCredentials: (r) => withHeaders(r, { authorization: `Bearer ${TOKEN}` }),
  withWrongCredentials: (r) => withHeaders(r, { authorization: `Bearer ${TOKEN.slice(0, -1)}x` }),
  payloads: [{ file: ACTIVATED, expect: "alerts", count: 1 }, { file: CLOSED, expect: "alerts", count: 1 }, { file: UNKNOWN, expect: "ignored" }],
  query: {
    routes: [{ method: "POST", url: ENDPOINT, body: read(TIMESERIES) }],
    exercise: (q, io) => q.metrics!({ service: "Checkout API (prod)", metric: "error_rate", window }, io),
    failureRoutes: (kind) => {
      switch (kind) {
        case "auth": return [{ method: "POST", url: ENDPOINT, status: 401, body: { error: "bad key" } }];
        case "rate_limited": return [{ method: "POST", url: ENDPOINT, status: 429, headers: { "retry-after": "30" }, body: "slow down" }];
        case "bad_response": return [{ method: "POST", url: ENDPOINT, body: read(GRAPHQL_ERROR) }];
        case "network": return [{ method: "POST", url: ENDPOINT, error: "network" }];
      }
    },
  },
});

describeConnectorConformance(newRelicConnector, {
  env: { NR_PASSWORD: TOKEN },
  entry: { ingest: { auth: { type: "basic", username: "newrelic", password: "${NR_PASSWORD}" } } },
  secrets: [TOKEN],
  withCredentials: (r) => withHeaders(r, { authorization: `Basic ${Buffer.from(`newrelic:${TOKEN}`).toString("base64")}` }),
  withWrongCredentials: (r) => withHeaders(r, { authorization: `Basic ${Buffer.from(`newrelic:${TOKEN}x`).toString("base64")}` }),
  payloads: [{ file: ACTIVATED, expect: "alerts", count: 1 }],
});

describeConnectorConformance(newRelicConnector, {
  env: { NR_HEADER: TOKEN },
  entry: { ingest: { auth: { type: "header", name: "x-copilot-token", value: "${NR_HEADER}" } } },
  secrets: [TOKEN],
  withCredentials: (r) => withHeaders(r, { "x-copilot-token": TOKEN }),
  withWrongCredentials: (r) => withHeaders(r, { "x-copilot-token": `${TOKEN}x` }),
  payloads: [{ file: CLOSED, expect: "alerts", count: 1 }],
});

type Entry = Record<string, unknown>;
function parseConfig(entry: Entry, env: Record<string, string> = { NR_TOKEN: TOKEN, NR_API_KEY: API_KEY }) {
  const text = JSON.stringify({ version: 1, connectors: [{ id: "nr", type: "newrelic", ...entry }] });
  return parseCopilotConfig(text, { format: "json", env, connectors: [newRelicConnector], notifiers: [] });
}
function instance(entry: Entry = {}) {
  const r = parseConfig({ ingest: { auth: { type: "bearer", token: "${NR_TOKEN}" } }, ...entry });
  assert.ok(r.ok, JSON.stringify(!r.ok && r.problems));
  const { fetch } = createFakeFetch([]);
  return createConnectorInstance(newRelicConnector, r.config.connectors[0]!, {
    http: createHttpClient({ fetch }), fetch, now: () => new Date(), logger: createLogger({ level: "error", secrets: [], write: () => {} }),
  });
}
const parse = (body: unknown, entry?: Entry) => instance(entry).ingest!.parse(body, inboundRequest({ connectorId: "nr" }));
const alertOf = (body: unknown, entry?: Entry) => {
  const out = parse(body, entry);
  assert.ok(out.kind === "alerts", JSON.stringify(out));
  assert.equal(out.alerts.length, 1);
  return out.alerts[0]!;
};

test("issue-activated.json: fields of the firing alert", () => {
  const a = alertOf(read(ACTIVATED));
  assert.deepEqual(
    { ...a, attributes: undefined },
    {
      source: "newrelic",
      externalId: "6f2d1c34-9b7e-4a58-8c1e-3d5f0a1b2c3d:ACTIVATED:1791106920000",
      fingerprint: "issue:6f2d1c34-9b7e-4a58-8c1e-3d5f0a1b2c3d",
      service: "Checkout API (prod)",
      title: "Checkout API error rate above 5% for at least 2 minutes",
      severity: "sev1",
      status: "firing",
      startedAt: "2026-10-04T09:40:00.000Z",
      url: "https://one.newrelic.com/alerts-ai/issues/6f2d1c34-9b7e-4a58-8c1e-3d5f0a1b2c3d",
      signal: "other",
      attributes: undefined,
    },
  );
  assert.deepEqual(a.attributes, {
    priority: "CRITICAL", state: "ACTIVATED", triggerEvent: "STATE_CHANGE", workflowName: "Send to incident-copilot",
    conditionName: "Error rate above 5%", policyName: "Checkout production", entityType: "APPLICATION",
  });
});

test("issue-closed.json: resolved, same fingerprint, the provider's close time", () => {
  const firing = alertOf(read(ACTIVATED));
  const a = alertOf(read(CLOSED));
  assert.equal(a.status, "resolved");
  assert.equal(a.fingerprint, firing.fingerprint);
  assert.notEqual(a.externalId, firing.externalId);
  assert.equal(a.externalId, "6f2d1c34-9b7e-4a58-8c1e-3d5f0a1b2c3d:CLOSED:1791109800000");
  assert.equal(a.startedAt, "2026-10-04T10:30:00.000Z");
});

test("issue-unknown-state.json is ignored; state is case-insensitive; CREATED fires", () => {
  const out = parse(read(UNKNOWN));
  assert.equal(out.kind, "ignored");
  assert.equal(alertOf({ ...read(ACTIVATED), state: "created" }).status, "firing");
  assert.equal(alertOf({ ...read(ACTIVATED), state: "closed" }).status, "resolved");
  assert.equal(parse({ ...read(ACTIVATED), state: undefined }).kind, "ignored");
});

test("severity: default map, case-insensitive priority, unknown priority sev2, severityMap override", () => {
  const sev = (priority: unknown, entry?: Entry) => alertOf({ ...read(ACTIVATED), priority }, entry).severity;
  assert.deepEqual(["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((p) => sev(p)), ["sev1", "sev2", "sev3", "sev3"]);
  assert.equal(sev("critical"), "sev1");
  assert.equal(sev("WEIRD"), "sev2");
  assert.equal(sev(undefined), "sev2");
  assert.equal(sev("LOW", { severityMap: { low: "sev1" } }), "sev1");
  assert.equal(sev("CRITICAL", { severityMap: { low: "sev1" } }), "sev2"); // an explicit map replaces the default one
});

test("issueId is required, as a string or a number; anything else is invalid", () => {
  assert.equal(parse({ ...read(ACTIVATED), issueId: undefined }).kind, "invalid");
  assert.equal(parse({ ...read(ACTIVATED), issueId: "" }).kind, "invalid");
  assert.equal(parse({ ...read(ACTIVATED), issueId: { a: 1 } }).kind, "invalid");
  const a = alertOf({ ...read(ACTIVATED), issueId: 4815162342 });
  assert.equal(a.fingerprint, "issue:4815162342");
  for (const body of [null, 1, "x", [], [{ issueId: "1" }]]) assert.equal(parse(body).kind, "invalid");
});

test("the title falls back to a generated one", () => {
  assert.equal(alertOf({ ...read(ACTIVATED), title: undefined }).title, "New Relic issue 6f2d1c34-9b7e-4a58-8c1e-3d5f0a1b2c3d");
  assert.equal(alertOf({ ...read(ACTIVATED), title: "   " }).title, "New Relic issue 6f2d1c34-9b7e-4a58-8c1e-3d5f0a1b2c3d");
});

test("service comes from every documented shape of entitiesData", () => {
  const svc = (entitiesData: unknown) => alertOf({ ...read(ACTIVATED), entitiesData }).service;
  assert.equal(svc({ names: ["a-svc", "b-svc"] }), "a-svc");
  assert.equal(svc({ names: "single" }), "single");
  assert.equal(svc({ entities: [{ name: "from-entities", type: "HOST" }] }), "from-entities");
  assert.equal(svc([{ name: "from-array", type: "HOST" }]), "from-array");
  assert.equal(svc(["plain-a", "plain-b"]), "plain-a");
  assert.equal(svc("just a string"), "just a string");
  assert.equal(svc({ names: [], entities: [{ name: "second-chance" }] }), "second-chance");
  assert.equal(svc(undefined), null);
  assert.equal(svc(null), null);
  assert.equal(svc({}), null);
  assert.equal(svc([]), null);
  assert.equal(svc(42), null);
});

test("entityType comes from entitiesData.types or entities[].type", () => {
  const attrs = (entitiesData: unknown) => alertOf({ ...read(ACTIVATED), entitiesData }).attributes;
  assert.equal(attrs({ names: ["a"], types: ["HOST", "APPLICATION"] }).entityType, "HOST");
  assert.equal(attrs({ entities: [{ name: "a", type: "SERVICE" }] }).entityType, "SERVICE");
  assert.equal("entityType" in attrs({ names: ["a"] }), false);
});

test("timestamps: epoch ms, epoch seconds, numeric strings and ISO strings all give the same instant", () => {
  const at = (createdAt: unknown) => alertOf({ ...read(ACTIVATED), createdAt }).startedAt;
  const expected = "2026-10-04T09:40:00.000Z";
  assert.equal(at(1791106800000), expected);
  assert.equal(at("1791106800000"), expected);
  assert.equal(at(1791106800), expected);
  assert.equal(at("2026-10-04T09:40:00Z"), expected);
  assert.equal(at("2026-10-04T09:40:00.000+00:00"), expected);
  // unreadable or missing: the time the webhook arrived
  assert.equal(at("yesterday"), INBOUND_RECEIVED_AT.toISOString());
  assert.equal(at(undefined), INBOUND_RECEIVED_AT.toISOString());
  assert.equal(at(null), INBOUND_RECEIVED_AT.toISOString());
});

test("a closed alert takes closedAt, then updatedAt, then the arrival time", () => {
  const closed = read(CLOSED);
  assert.equal(alertOf({ ...closed, closedAt: "2026-10-04T10:31:00Z" }).startedAt, "2026-10-04T10:31:00.000Z");
  assert.equal(alertOf({ ...closed, closedAt: null }).startedAt, "2026-10-04T10:30:00.000Z"); // updatedAt
  assert.equal(alertOf({ ...closed, closedAt: null, updatedAt: undefined }).startedAt, INBOUND_RECEIVED_AT.toISOString());
});

test("externalId uses updatedAt, then createdAt, then the arrival time", () => {
  const base = { ...read(ACTIVATED) };
  assert.equal(alertOf(base).externalId.endsWith(":ACTIVATED:1791106920000"), true);
  assert.equal(alertOf({ ...base, updatedAt: undefined }).externalId.endsWith(":ACTIVATED:1791106800000"), true);
  assert.equal(alertOf({ ...base, updatedAt: undefined, createdAt: undefined }).externalId.endsWith(`:ACTIVATED:${INBOUND_RECEIVED_AT.toISOString()}`), true);
  const noTimes = { ...base, updatedAt: undefined, createdAt: undefined };
  assert.equal(alertOf(noTimes).startedAt, INBOUND_RECEIVED_AT.toISOString());
});

test("url must be http(s); other schemes become null", () => {
  assert.equal(alertOf({ ...read(ACTIVATED), issuePageUrl: "javascript:alert(1)" }).url, null);
  assert.equal(alertOf({ ...read(ACTIVATED), issuePageUrl: undefined }).url, null);
});

test("vendor text is sanitized: controls removed, delimiters neutralized, clipped", () => {
  const a = alertOf({ ...read(ACTIVATED), title: "bad\u0000 <<<UNTRUSTED>>> title" + "x".repeat(500), conditionName: "c‮ond", workflowName: "w".repeat(900) });
  assert.ok(!a.title.includes("<<<") && !a.title.includes("\u0000"));
  assert.ok(a.title.length <= 200);
  assert.equal(a.attributes.conditionName, "cond");
  assert.ok(a.attributes.workflowName!.length <= 500);
});

test("config: ingest or query is required, strict keys, secrets only as references", () => {
  const rules = (entry: Entry) => {
    const r = parseConfig(entry);
    return r.ok ? [] : r.problems;
  };
  assert.notDeepEqual(rules({}), []);
  assert.notDeepEqual(rules({ ingest: { auth: { type: "bearer", token: "${NR_TOKEN}" }, extra: 1 } }), []);
  assert.notDeepEqual(rules({ ingest: { auth: { type: "bearer", token: "literal-token-literal-token" } } }), []);
  assert.notDeepEqual(rules({ ingest: { auth: { type: "hmac", header: "x-sig", secret: "${NR_TOKEN}" } } }), [], "New Relic documents no signing, so hmac is not offered");
  assert.notDeepEqual(rules({ ingest: { auth: { type: "path_token", token: "${NR_TOKEN}" } } }), []);
  assert.notDeepEqual(rules({ query: { ...QUERY_ENTRY, region: "ap" } }), []);
  assert.notDeepEqual(rules({ query: { ...QUERY_ENTRY, accountId: 0 } }), []);
  assert.notDeepEqual(rules({ query: { ...QUERY_ENTRY, accountId: 1.5 } }), []);
  assert.notDeepEqual(rules({ query: { ...QUERY_ENTRY, apiKey: "NRAK-literal-key-value-123" } }), []);
  assert.notDeepEqual(rules({ query: { ...QUERY_ENTRY, apiKey: "${MISSING_VAR}" } }), []);
  assert.deepEqual(rules({ query: QUERY_ENTRY }), []);
  assert.deepEqual(rules({ query: { accountId: 1, apiKey: "${NR_API_KEY}" } }), [], "region defaults to us");
});

test("config: NRQL templates are validated at load time", () => {
  const bad = (nrql: Entry) => {
    const r = parseConfig({ query: { ...QUERY_ENTRY, nrql } });
    return r.ok ? null : r.problems.map((p) => `${p.path}: ${p.rule}`).join("\n");
  };
  const ok = "SELECT count(*) FROM Transaction WHERE appName = '{service}' SINCE {since} UNTIL {until}";
  assert.equal(bad({ metrics: { error_count: ok } }), null);
  assert.equal(bad({ errors: null, logs: null, deploys: null }), null);
  assert.match(bad({ metrics: { error_count: "DROP TABLE x '{service}'" } })!, /SELECT or FROM/);
  assert.match(bad({ metrics: { error_count: "SELECT count(*) FROM Transaction" } })!, /\{service\}/);
  assert.match(bad({ metrics: { error_count: "SELECT count(*) FROM T WHERE appName = {service}" } })!, /single quotes/);
  assert.match(bad({ metrics: { error_count: "SELECT {foo} FROM T WHERE a = '{service}'" } })!, /placeholder/);
  assert.match(bad({ metrics: { error_count: "SELECT count(*) FROM T WHERE a = '{service}' AND level = '{level}'" } })!, /placeholder/);
  assert.match(bad({ metrics: { "Bad Name": ok } })!, /./);
  assert.match(bad({ metrics: { "9lives": ok } })!, /./);
  assert.match(bad({ metrics: { error_rate: `${ok} ${"x".repeat(2001)}` } })!, /./);
  assert.equal(bad({ logs: "SELECT message FROM Log WHERE service.name = '{service}' AND level = '{level}'" }), null);
  assert.match(bad({ nrql: 1 })!, /./);
});

test("capabilities follow the entry: ingest only, query only, both", () => {
  const onlyIngest = instance();
  assert.ok(onlyIngest.ingest);
  assert.equal(onlyIngest.query, null);
  const onlyQuery = instance({ ingest: undefined, query: QUERY_ENTRY });
  assert.equal(onlyQuery.ingest, null);
  assert.ok(onlyQuery.query);
  assert.equal(onlyQuery.type, "newrelic");
});
