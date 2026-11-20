// Generic JSON webhook connector (spec 008; docs/connectors/webhook.md): the shared conformance kit (Bearer, then HMAC)
// plus the field mapping cases. Payloads are our own examples in tests/fixtures/connectors/webhook/.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webhookConnector } from "../../src/connectors/webhook/index.ts";
import { createConnectorInstance } from "../../src/connectors/registry.ts";
import { createHttpClient } from "../../src/connectors/shared/http.ts";
import { hmacDigest } from "../../src/infra/crypto.ts";
import { parseCopilotConfig } from "../../src/infra/copilot-config/load.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { describeConnectorConformance } from "../helpers/connector-conformance.ts";
import { createFakeFetch } from "../helpers/fake-fetch.ts";
import { INBOUND_RECEIVED_AT, inboundRequest, withHeaders } from "../helpers/inbound.ts";

const DIR = "tests/fixtures/connectors/webhook";
const SINGLE = `${DIR}/single.json`;
const RESOLVED = `${DIR}/resolved.json`;
const BATCH = `${DIR}/batch.json`;
const NESTED = `${DIR}/nested.json`;
const read = (f: string): unknown => JSON.parse(readFileSync(f, "utf8"));

const TOKEN = "wh-bearer-" + "a".repeat(24);
const HMAC_SECRET = "wh-hmac-" + "b".repeat(24);

const FLAT_MAPPING = {
  externalId: "event_id",
  fingerprint: "monitor",
  service: "service",
  title: "message",
  severity: { path: "level", map: { high: "sev1", medium: "sev2" } },
  status: { path: "state" },
  startedAt: "fired_at",
  url: "details_url",
  attributes: { region: "region", team: "tags.team" },
};
const BATCH_MAPPING = {
  alerts: "alerts",
  externalId: "id",
  fingerprint: "id",
  service: "app",
  title: { template: "{name} on {host}" },
  severity: { path: "sev", map: { critical: "sev1", warning: "sev2" }, default: "sev3" },
  status: { path: "status" },
  startedAt: "at",
};

describeConnectorConformance(webhookConnector, {
  env: { WH_TOKEN: TOKEN },
  entry: { ingest: { auth: { type: "bearer", token: "${WH_TOKEN}" }, mapping: FLAT_MAPPING } },
  secrets: [TOKEN],
  withCredentials: (r) => withHeaders(r, { authorization: `Bearer ${TOKEN}` }),
  withWrongCredentials: (r) => withHeaders(r, { authorization: `Bearer ${TOKEN.slice(0, -1)}x` }),
  payloads: [{ file: SINGLE, expect: "alerts", count: 1 }, { file: RESOLVED, expect: "alerts", count: 1 }],
});

const sign = (body: Buffer) => `sha256=${hmacDigest("sha256", HMAC_SECRET, body, "hex")}`;
describeConnectorConformance(webhookConnector, {
  env: { WH_SECRET: HMAC_SECRET },
  entry: { ingest: { auth: { type: "hmac", header: "x-signature", secret: "${WH_SECRET}", prefix: "sha256=" }, mapping: BATCH_MAPPING } },
  secrets: [HMAC_SECRET],
  withCredentials: (r) => withHeaders(r, { "x-signature": sign(r.rawBody) }),
  withWrongCredentials: (r) => withHeaders(r, { "x-signature": `sha256=${"0".repeat(64)}` }),
  payloads: [{ file: BATCH, expect: "alerts", count: 2 }],
});

// ---- helpers for the mapping cases ----
const ENV = { WH_TOKEN: TOKEN };
const auth = { type: "bearer", token: "${WH_TOKEN}" };
function load(ingest: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const text = JSON.stringify({ version: 1, connectors: [{ id: "hook", type: "webhook", ingest: { auth, ...ingest }, ...extra }] });
  return parseCopilotConfig(text, { format: "json", env: ENV, connectors: [webhookConnector], notifiers: [] });
}
function instance(ingest: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const r = load(ingest, extra);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.problems));
  const { fetch } = createFakeFetch([]);
  return createConnectorInstance(webhookConnector, r.config.connectors[0]!, {
    http: createHttpClient({ fetch }), fetch, now: () => new Date(), logger: createLogger({ level: "error", secrets: [], write: () => {} }),
  });
}
const parse = (ingest: Record<string, unknown>, body: unknown, extra: Record<string, unknown> = {}) =>
  instance(ingest, extra).ingest!.parse(body, inboundRequest({ connectorId: "hook" }));
const alertsOf = (out: ReturnType<typeof parse>) => {
  assert.equal(out.kind, "alerts", JSON.stringify(out));
  return out.kind === "alerts" ? out.alerts : [];
};
const MIN = { externalId: "id", title: "t" };

describe("field mapping", () => {
  test("single.json: every mapped field", () => {
    const [a] = alertsOf(parse({ mapping: FLAT_MAPPING }, read(SINGLE)));
    assert.deepEqual(a, {
      source: "webhook", externalId: "evt-1001", fingerprint: "checkout-latency", service: "checkout",
      title: "p99 latency above 1.2s for 5 minutes", severity: "sev1", status: "firing", startedAt: "2026-10-04T09:41:30.000Z",
      url: "https://monitor.example.com/events/1001", signal: "other", attributes: { region: "eu-west", team: "payments" },
    });
  });

  test("resolved.json: OK is a resolved value, epoch seconds are read as seconds", () => {
    const [a] = alertsOf(parse({ mapping: FLAT_MAPPING }, read(RESOLVED)));
    assert.equal(a!.status, "resolved");
    assert.equal(a!.startedAt, "2026-10-04T09:50:00.000Z");
    assert.equal(a!.severity, "sev1", "the severity map ignores case");
  });

  test("batch.json: alerts path, template title, one element without an id is skipped", () => {
    const alerts = alertsOf(parse({ mapping: BATCH_MAPPING }, read(BATCH)));
    assert.deepEqual(alerts.map((a) => a.externalId), ["b-1", "b-3"]);
    assert.equal(alerts[0]!.title, "disk usage on db-1");
    assert.equal(alerts[0]!.startedAt, "2026-10-04T09:41:30.000Z", "epoch milliseconds");
    assert.equal(alerts[0]!.severity, "sev1");
    assert.equal(alerts[1]!.severity, "sev3", "an unlisted value takes the default");
    assert.equal(alerts[1]!.status, "resolved", "resolvedValues match without regard to case");
    assert.equal(alerts[1]!.startedAt, "2026-10-04T09:45:00.000Z");
    assert.equal(alerts[1]!.service, "checkout");
  });

  test("nested.json: numeric index paths, numbers and booleans become text", () => {
    const mapping = {
      externalId: "data.events.0.ref.id", service: "data.events.0.labels.1",
      title: { template: "Latency {data.events.0.metrics.latency_ms} ms on {data.events.0.labels.1}" },
      attributes: { open: "data.events.0.open", producer: "meta.producer" },
    };
    const [a] = alertsOf(parse({ mapping }, read(NESTED)));
    assert.equal(a!.externalId, "n-77");
    assert.equal(a!.title, "Latency 1840 ms on checkout");
    assert.equal(a!.service, "checkout");
    assert.deepEqual(a!.attributes, { open: "true", producer: "internal-monitor" });
    assert.equal(a!.fingerprint, "n-77", "the fingerprint defaults to the externalId");
  });

  test("defaults: severity sev3, always firing, startedAt is the receive time, signal other, no service or url", () => {
    const [a] = alertsOf(parse({ mapping: MIN }, { id: "x1", t: "Something broke" }));
    assert.deepEqual(a, {
      source: "webhook", externalId: "x1", fingerprint: "x1", service: null, title: "Something broke", severity: "sev3", status: "firing",
      startedAt: INBOUND_RECEIVED_AT.toISOString(), url: null, signal: "other", attributes: {},
    });
  });

  test("the configured signal is kept", () => {
    assert.equal(alertsOf(parse({ mapping: { ...MIN, signal: "http_5xx_rate" } }, { id: "x", t: "t" }))[0]!.signal, "http_5xx_rate");
  });

  test("template: missing placeholders render empty; none resolved skips the element", () => {
    const m = { externalId: "id", title: { template: "{a} / {b}" } };
    assert.equal(alertsOf(parse({ mapping: m }, { id: "1", a: "only-a" }))[0]!.title, "only-a /");
    assert.equal(parse({ mapping: m }, { id: "1" }).kind, "invalid");
  });

  test("severity: the entry severityMap covers values the mapping does not list; the mapping wins otherwise", () => {
    const ingest = { mapping: { ...MIN, severity: { path: "s", map: { urgent: "sev1" }, default: "sev3" } } };
    const sev = (s: string) => alertsOf(parse(ingest, { id: "1", t: "t", s }, { severityMap: { urgent: "sev2", low: "sev3", major: "sev2" } }))[0]!.severity;
    assert.equal(sev("urgent"), "sev1");
    assert.equal(sev("MAJOR"), "sev2");
    assert.equal(sev("unknown"), "sev3");
  });

  test("severity default can be changed; a missing value takes it", () => {
    const ingest = { mapping: { ...MIN, severity: { path: "s", map: {}, default: "sev2" } } };
    assert.equal(alertsOf(parse(ingest, { id: "1", t: "t" }))[0]!.severity, "sev2");
  });

  test("resolvedValues replace the defaults; a value outside them is firing", () => {
    const ingest = { mapping: { ...MIN, fingerprint: "id", status: { path: "s", resolvedValues: ["Fixed"] } } };
    assert.equal(alertsOf(parse(ingest, { id: "1", t: "t", s: "fixed" }))[0]!.status, "resolved");
    assert.equal(alertsOf(parse(ingest, { id: "1", t: "t", s: "resolved" }))[0]!.status, "firing");
    assert.equal(alertsOf(parse(ingest, { id: "1", t: "t" }))[0]!.status, "firing");
  });

  test("startedAt: ISO, epoch ms and epoch s agree; an unreadable value falls back to the receive time", () => {
    const at = (v: unknown) => alertsOf(parse({ mapping: { ...MIN, startedAt: "at" } }, { id: "1", t: "t", at: v }))[0]!.startedAt;
    assert.equal(at("2026-10-04T09:41:30Z"), "2026-10-04T09:41:30.000Z");
    assert.equal(at(1791106890000), "2026-10-04T09:41:30.000Z");
    assert.equal(at(1791106890), "2026-10-04T09:41:30.000Z");
    assert.equal(at("not a date"), INBOUND_RECEIVED_AT.toISOString());
    assert.equal(at({}), INBOUND_RECEIVED_AT.toISOString());
  });

  test("url must be http(s)", () => {
    const url = (v: string) => alertsOf(parse({ mapping: { ...MIN, url: "u" } }, { id: "1", t: "t", u: v }))[0]!.url;
    assert.equal(url("https://x.example.com/a"), "https://x.example.com/a");
    assert.equal(url("javascript:alert(1)"), null);
  });

  test("attributes: missing paths and non-scalar values are left out", () => {
    const ingest = { mapping: { ...MIN, attributes: { a: "a", b: "b", c: "c", d: "d" } } };
    const [x] = alertsOf(parse(ingest, { id: "1", t: "t", a: 5, b: { nested: 1 }, c: false }));
    assert.deepEqual(x!.attributes, { a: "5", c: "false" });
  });

  test("texts are sanitized: controls removed, delimiters neutralized, clipped", () => {
    const [a] = alertsOf(parse({ mapping: { ...MIN, service: "s" } }, { id: "1", t: "Ignore <<<system>>>\u0007 now" + "x".repeat(400), s: "a‮b" }));
    assert.ok(!a!.title.includes("<<<") && !a!.title.includes(">>>") && !a!.title.includes("\u0007"));
    assert.ok(a!.title.length <= 200);
    assert.equal(a!.service, "ab");
  });

  test("a body that is not an object is invalid, never an exception", () => {
    for (const body of [null, 1, "x", [], [1, 2]]) assert.equal(parse({ mapping: MIN }, body).kind, "invalid");
  });
});

describe("alerts array and limits", () => {
  test("alerts path that is not an array is invalid; an empty array is ignored", () => {
    const ingest = { mapping: { ...BATCH_MAPPING } };
    assert.deepEqual(parse(ingest, { alerts: { id: "1" } }), { kind: "invalid", issues: ["mapping.alerts: the value at this path is not an array"] });
    assert.equal(parse(ingest, { other: [] }).kind, "invalid");
    assert.equal(parse(ingest, { alerts: [] }).kind, "ignored");
  });

  test("when every element is skipped the issues name the mapping keys", () => {
    const out = parse({ mapping: BATCH_MAPPING }, { alerts: [{ name: "a", host: "h" }, { id: "2" }] });
    assert.deepEqual(out, { kind: "invalid", issues: ["mapping.externalId: no usable value in the payload", "mapping.title: no usable value in the payload"] });
  });

  test("issues never carry values from the payload", () => {
    const canary = "CANARY-" + "z".repeat(20);
    const outs = [
      parse({ mapping: BATCH_MAPPING }, { alerts: { x: canary } }),
      parse({ mapping: BATCH_MAPPING }, { alerts: [{ other: canary }] }),
      parse({ mapping: { ...MIN } }, { t: canary }),
      parse({ mapping: { ...MIN } }, { id: { nested: canary }, t: canary }),
    ];
    for (const o of outs) {
      assert.equal(o.kind, "invalid");
      assert.ok(!JSON.stringify(o).includes(canary));
    }
  });

  test("maxAlertsPerRequest drops the rest and counts them on the first alert", () => {
    const alerts = Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, name: "n", host: "h" }));
    const out = alertsOf(parse({ mapping: BATCH_MAPPING, maxAlertsPerRequest: 3 }, { alerts }));
    assert.deepEqual(out.map((a) => a.externalId), ["e0", "e1", "e2"]);
    assert.equal(out[0]!.attributes.truncated, "2");
    assert.equal(out[1]!.attributes.truncated, undefined);
  });

  test("the default limit is 20 and the truncated marker survives 20 configured attributes", () => {
    const names = Array.from({ length: 20 }, (_, i) => `a${i}`);
    const mapping = { ...BATCH_MAPPING, attributes: Object.fromEntries(names.map((n) => [n, n])) };
    const element = (i: number) => ({ id: `e${i}`, name: "n", host: "h", ...Object.fromEntries(names.map((n) => [n, "1"])) });
    const out = alertsOf(parse({ mapping }, { alerts: Array.from({ length: 25 }, (_, i) => element(i)) }));
    assert.equal(out.length, 20);
    assert.equal(out[0]!.attributes.truncated, "5");
    assert.equal(Object.keys(out[0]!.attributes).length, 20);
  });
});

describe("config validation at load time", () => {
  const problem = (ingest: Record<string, unknown>) => {
    const r = load(ingest);
    assert.equal(r.ok, false);
    return r.ok ? [] : r.problems;
  };

  test("status without fingerprint is refused: a resolved event would never match the firing incident", () => {
    const p = problem({ mapping: { ...MIN, status: { path: "s" } } });
    assert.deepEqual(p.map((x) => x.path), ["connectors[0].ingest.mapping.fingerprint"]);
    assert.match(p[0]!.rule, /fingerprint is required when status is mapped/);
    assert.ok(load({ mapping: { ...MIN, fingerprint: "monitor", status: { path: "s" } } }).ok, "with a fingerprint it loads");
    assert.ok(load({ mapping: { ...MIN } }).ok, "without status the fingerprint stays optional");
  });

  test("prototype and malformed paths are rejected, and the rule never echoes the value", () => {
    for (const bad of ["__proto__.x", "a.constructor", "CANARYvalue..x", "prototype", "a..b", "a b", "a.", ".a", "$.a", "a[0]", "1.2.3.4.5.6.7.8.9.10.11"]) {
      const p = problem({ mapping: { externalId: bad, title: "t" } });
      assert.ok(p.some((x) => x.path.includes("externalId")), `${bad}: ${JSON.stringify(p)}`);
      assert.ok(!JSON.stringify(p).includes("CANARY"), "the offending value is not echoed");
    }
    assert.ok(problem({ mapping: { externalId: "id", title: "a.__proto__" } }).length > 0);
    assert.ok(problem({ mapping: { externalId: "id", title: "t", attributes: { x: "constructor.name" } } }).length > 0);
    assert.ok(problem({ mapping: { ...MIN, alerts: "__proto__" } }).length > 0);
  });

  test("ten segments are fine, eleven are not", () => {
    assert.equal(load({ mapping: { externalId: "a.b.c.d.e.f.g.h.i.j", title: "t" } }).ok, true);
  });

  test("template placeholders: at most 10, each a valid path, no stray braces", () => {
    const tpl = (template: string) => load({ mapping: { externalId: "id", title: { template } } }).ok;
    assert.equal(tpl("{a} {b.0.c}"), true);
    assert.equal(tpl("plain text"), true);
    assert.equal(tpl(Array.from({ length: 10 }, (_, i) => `{p${i}}`).join(" ")), true);
    assert.equal(tpl(Array.from({ length: 11 }, (_, i) => `{p${i}}`).join(" ")), false);
    assert.equal(tpl("{__proto__.x}"), false);
    assert.equal(tpl("{}"), false);
    assert.equal(tpl("{a"), false);
    assert.equal(tpl("a} b"), false);
  });

  test("strict: unknown keys, bad severity, bad attribute names, limits", () => {
    assert.equal(load({ mapping: { ...MIN, extra: "x" } }).ok, false);
    assert.equal(load({ mapping: { ...MIN, severity: { path: "s", map: { a: "sev9" } } } }).ok, false);
    assert.equal(load({ mapping: { ...MIN, attributes: { "bad name!": "x" } } }).ok, false);
    assert.equal(load({ mapping: { ...MIN, attributes: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`a${i}`, "x"])) } }).ok, false);
    assert.equal(load({ mapping: MIN, maxAlertsPerRequest: 0 }).ok, false);
    assert.equal(load({ mapping: MIN, maxAlertsPerRequest: 101 }).ok, false);
    assert.equal(load({ mapping: MIN, maxAlertsPerRequest: 100 }).ok, true);
    assert.equal(load({ mapping: { ...MIN, signal: "nonsense" } }).ok, false);
  });

  test("ingest, auth, externalId and title are required; the auth kinds of the spec are accepted", () => {
    const text = (c: Record<string, unknown>) => JSON.stringify({ version: 1, connectors: [{ id: "hook", type: "webhook", ...c }] });
    const run = (c: Record<string, unknown>) => parseCopilotConfig(text(c), { format: "json", env: ENV, connectors: [webhookConnector], notifiers: [] }).ok;
    assert.equal(run({}), false);
    assert.equal(run({ ingest: { mapping: MIN } }), false, "no auth");
    assert.equal(run({ ingest: { auth, mapping: { title: "t" } } }), false);
    assert.equal(run({ ingest: { auth, mapping: { externalId: "id" } } }), false);
    const kinds = [
      { type: "basic", username: "u", password: "${WH_TOKEN}" },
      { type: "header", name: "x-hook-key", value: "${WH_TOKEN}" },
      { type: "hmac", header: "x-signature", secret: "${WH_TOKEN}" },
      { type: "path_token", token: "${WH_TOKEN}" },
    ];
    for (const a of kinds) assert.equal(run({ ingest: { auth: a, mapping: MIN } }), true, a.type);
    assert.equal(run({ ingest: { auth: { type: "bearer", token: "plain-text-secret-value" }, mapping: MIN } }), false, "secrets must be ${VAR}");
  });

  test("capabilities are ingest only", () => {
    assert.deepEqual([...webhookConnector.capabilities], ["ingest"]);
    assert.equal(instance({ mapping: MIN }).query, null);
  });
});

describe("auth through the connector", () => {
  test("hmac verifies the raw bytes: a re-serialized body does not match", () => {
    const i = instance({ auth: { type: "hmac", header: "x-signature", secret: "${WH_TOKEN}", prefix: "sha256=" }, mapping: MIN });
    const raw = Buffer.from('{"id": "1",   "t":"x"}', "utf8");
    const sig = `sha256=${hmacDigest("sha256", TOKEN, raw, "hex")}`;
    assert.deepEqual(i.ingest!.verify(inboundRequest({ body: raw, headers: { "x-signature": sig } })), { ok: true });
    const respaced = Buffer.from('{"id":"1","t":"x"}', "utf8");
    assert.equal(i.ingest!.verify(inboundRequest({ body: respaced, headers: { "x-signature": sig } })).ok, false);
    assert.equal(i.ingest!.verify(inboundRequest({ body: raw })).ok, false);
  });

  test("path_token auth", () => {
    const token = "p".repeat(32);
    const text = JSON.stringify({ version: 1, connectors: [{ id: "hook", type: "webhook", ingest: { auth: { type: "path_token", token: "${PT}" }, mapping: MIN } }] });
    const r = parseCopilotConfig(text, { format: "json", env: { PT: token }, connectors: [webhookConnector], notifiers: [] });
    assert.ok(r.ok, JSON.stringify(!r.ok && r.problems));
    const { fetch } = createFakeFetch([]);
    const i = createConnectorInstance(webhookConnector, r.config.connectors[0]!, {
      http: createHttpClient({ fetch }), fetch, now: () => new Date(), logger: createLogger({ level: "error", secrets: [], write: () => {} }),
    });
    assert.deepEqual(i.ingest!.verify(inboundRequest({ pathToken: token })), { ok: true });
    assert.equal(i.ingest!.verify(inboundRequest({ pathToken: token + "x" })).ok, false);
  });
});
