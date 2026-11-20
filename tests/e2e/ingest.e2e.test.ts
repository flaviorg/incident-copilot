// POST /ingest/:connectorId (spec 008; AC-42 to AC-45): fast 202, idempotency, per-connector authentication, body cap,
// rate limit, unknown connector, invalid payload and a full queue, with nothing recorded on a rejection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildServer } from "../../src/http/server.ts";
import { alertmanagerConnector } from "../../src/connectors/alertmanager/index.ts";
import { webhookConnector } from "../../src/connectors/webhook/index.ts";
import { createTestContainer } from "../helpers/container.ts";
import type { TestContainer } from "../helpers/container.ts";
import { liveCopilot } from "../helpers/live.ts";
import { findSecretOccurrences } from "../helpers/secret-scan.ts";

const TOKEN = "am-hook-" + "k".repeat(30);
const API = "api-token-" + "z".repeat(30);
const FIRING = readFileSync("tests/fixtures/connectors/alertmanager/firing.json", "utf8");

const yaml = (ingest = "", auth = 'type: bearer, token: "\${AM_TOKEN}"') => `
version: 1
${ingest}
services:
  - name: checkout-api
    aliases: { prom: [checkout] }
connectors:
  - id: prom
    type: alertmanager
    ingest: { auth: { ${auth} } }
`;

function setup(o: { ingest?: string; auth?: string; env?: Record<string, string>; hold?: boolean } = {}) {
  const copilot = liveCopilot(yaml(o.ingest, o.auth), { env: { AM_TOKEN: TOKEN }, connectors: [alertmanagerConnector] });
  const c = createTestContainer({ copilot, connectorDefinitions: [alertmanagerConnector], ...(o.env ? { env: o.env } : {}) });
  // The queue is not under test here: hold every run slot so jobs stay queued and no graph runs.
  if (o.hold !== false) for (let i = 0; i < c.config.maxConcurrentRuns; i++) c.runSlots.tryAcquire();
  return { c, app: buildServer(c) };
}

const post = (app: ReturnType<typeof buildServer>, url: string, body: string | Buffer, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: body, headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers } });

/** firing.json with only its firing alert, moved to a new start time (a new provider event). */
function refired(startsAt: string): string {
  const p = JSON.parse(FIRING);
  p.alerts = [{ ...p.alerts[0], startsAt }];
  return JSON.stringify(p);
}

const recorded = (c: TestContainer) => c.store.listIngestedAlerts({ limit: 200 }).length;

test("202 with the documented shape; alerts recorded as queued and enqueued, no LLM call in the request", async () => {
  const { c, app } = setup();
  const r = await post(app, "/ingest/prom", FIRING);
  assert.equal(r.statusCode, 202);
  const body = r.json();
  assert.deepEqual(Object.keys(body).sort(), ["accepted", "alertIds", "duplicates", "ignored", "requestId"]);
  assert.deepEqual([body.accepted, body.duplicates, body.ignored, body.alertIds], [2, 0, null, ["ALR-0001", "ALR-0002"]]);
  assert.equal(body.requestId, r.headers["x-request-id"]);
  const rows = c.store.listIngestedAlerts({ limit: 10 });
  assert.deepEqual(rows.map((x) => x.outcome), ["queued", "queued"]);
  assert.ok(rows.every((x) => x.alert.service === "checkout-api"), "the alias maps to the canonical service");
  assert.ok(rows.every((x) => x.requestId === body.requestId));
  assert.equal(c.alertQueue.size(), 2);
  assert.equal(c.fake.calls().length, 0);
  assert.equal(c.store.listIncidents({ limit: 10 }).length, 0);
});

test("a repeated payload counts duplicates and enqueues nothing", async () => {
  const { c, app } = setup();
  await post(app, "/ingest/prom", FIRING);
  const again = (await post(app, "/ingest/prom", FIRING)).json();
  assert.deepEqual([again.accepted, again.duplicates, again.alertIds], [0, 2, []]);
  assert.equal(recorded(c), 2);
  assert.equal(c.alertQueue.size(), 2);
});

test("401 without, with a wrong and with a malformed token; nothing recorded and no token in any log", async () => {
  const { c, app } = setup();
  for (const auth of [undefined, `Bearer ${TOKEN}x`, "Bearer", "Basic Zm9vOmJhcg==", TOKEN]) {
    const headers: Record<string, string> = auth === undefined ? {} : { authorization: auth };
    const r = await app.inject({ method: "POST", url: "/ingest/prom", payload: FIRING, headers: { "content-type": "application/json", ...headers } });
    assert.equal(r.statusCode, 401, String(auth));
    assert.deepEqual(r.json().error.code, "invalid_webhook_credentials");
    assert.equal(r.json().error.message, "invalid or missing webhook credentials");
  }
  assert.equal(recorded(c), 0);
  assert.ok(c.logs.some((l) => l.includes("ingest_unauthorized") && l.includes("\"connectorId\":\"prom\"")));
  assert.deepEqual(findSecretOccurrences([{ name: "logs", text: c.logs.join("\n") }], [TOKEN]), []);
});

test("413 over the body cap, nothing recorded", async () => {
  const { c, app } = setup({ ingest: "ingest: { maxBodyBytes: 2048 }" });
  const big = JSON.stringify({ alerts: [], pad: "x".repeat(4000) });
  const r = await post(app, "/ingest/prom", big);
  assert.equal(r.statusCode, 413);
  assert.equal(r.json().error.code, "payload_too_large");
  assert.equal(recorded(c), 0);
  // The cap of the other routes stays 64 KB, and ingest's own cap applies only to ingest.
  assert.equal((await post(app, "/ingest/prom", JSON.stringify({ alerts: [] }))).statusCode, 202);
});

test("429 with Retry-After once the connector's bucket is empty", async () => {
  const { c, app } = setup({ ingest: "ingest: { rateLimitPerMin: 2 }" });
  const empty = JSON.stringify({ alerts: [] });
  assert.equal((await post(app, "/ingest/prom", empty)).statusCode, 202);
  assert.equal((await post(app, "/ingest/prom", empty)).statusCode, 202);
  const r = await post(app, "/ingest/prom", FIRING);
  assert.equal(r.statusCode, 429);
  assert.equal(r.json().error.code, "ingest_rate_limited");
  assert.equal(r.headers["retry-after"], "30");
  assert.equal(recorded(c), 0);
});

test("404 for an unknown connector", async () => {
  const { c, app } = setup();
  const r = await post(app, "/ingest/nagios", FIRING);
  assert.deepEqual([r.statusCode, r.json().error.code], [404, "connector_not_found"]);
  assert.equal(recorded(c), 0);
});

test("400 for a non-JSON or invalid body, without echoing it; 202 ignored for an empty alert list", async () => {
  const { c, app } = setup();
  const marker = "do-not-echo-" + "m".repeat(10);
  for (const body of [`{ ${marker}`, JSON.stringify({ status: marker }), ""]) {
    const r = await post(app, "/ingest/prom", body);
    assert.equal(r.statusCode, 400, body);
    assert.equal(r.json().error.code, "invalid_payload");
    assert.ok(!r.body.includes(marker));
  }
  assert.ok(!c.logs.join("\n").includes(marker));
  const ignored = await post(app, "/ingest/prom", JSON.stringify({ alerts: [] }));
  assert.deepEqual([ignored.statusCode, ignored.json().accepted, ignored.json().ignored], [202, 0, "no alerts in the payload"]);
  // Any content type is read as raw bytes, and so is a body without one.
  const text = await app.inject({ method: "POST", url: "/ingest/prom", payload: FIRING, headers: { "content-type": "text/plain", authorization: `Bearer ${TOKEN}` } });
  assert.equal(text.statusCode, 202);
  const none = await app.inject({ method: "POST", url: "/ingest/prom", payload: Buffer.from(FIRING), headers: { authorization: `Bearer ${TOKEN}` } });
  assert.deepEqual([none.statusCode, none.json().duplicates], [202, 2]);
  // A malformed content-type header is refused by Fastify before any parser (docs/api-notes.md).
  const malformed = await app.inject({ method: "POST", url: "/ingest/prom", payload: FIRING, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "" } });
  assert.equal(malformed.statusCode, 415);
  assert.equal(recorded(c), 2);
});

test("503 only when the queue is already full, with nothing recorded; the alerts of one request are never split", async () => {
  const { c, app } = setup({ ingest: "ingest: { maxQueued: 2 }" });
  const first = await post(app, "/ingest/prom", FIRING);
  assert.deepEqual([first.statusCode, first.json().accepted], [202, 2]);
  const r = await post(app, "/ingest/prom", refired("2026-10-04T09:55:00Z"));
  assert.deepEqual([r.statusCode, r.json().error.code], [503, "ingest_queue_full"]);
  assert.ok(r.headers["retry-after"]);
  assert.equal(recorded(c), 2, "nothing recorded by the refused request");
});

test("a group larger than maxQueued is accepted whole while the queue has room: the rows are the durable queue", async () => {
  const { c, app } = setup({ ingest: "ingest: { maxQueued: 1 }" });
  const r = await post(app, "/ingest/prom", FIRING);
  assert.deepEqual([r.statusCode, r.json().accepted], [202, 2], "two fresh alerts, one slot of room: not a 503 that every retry would repeat");
  assert.equal(recorded(c), 2);
  assert.equal(c.alertQueue.size(), 2);
});

test("bad credentials never spend the connector's rate-limit tokens, so a flood cannot starve the real provider", async () => {
  const { c, app } = setup({ ingest: "ingest: { rateLimitPerMin: 2 }" });
  for (let i = 0; i < 6; i++) {
    const bad = await post(app, "/ingest/prom", FIRING, { authorization: "Bearer wrong-" + "x".repeat(20) });
    assert.equal(bad.statusCode, 401);
  }
  const missing = await app.inject({ method: "POST", url: "/ingest/prom", payload: FIRING, headers: { "content-type": "application/json" } });
  assert.equal(missing.statusCode, 401);
  const ok = await post(app, "/ingest/prom", FIRING);
  assert.equal(ok.statusCode, 202, "the authenticated request still finds its tokens");
  assert.equal(recorded(c), 2);
});

test("with API_TOKEN set, ingest needs no bearer of the API while GET /connectors does; no token is ever echoed", async () => {
  const { c, app } = setup({ env: { API_TOKEN: API } });
  const r = await post(app, "/ingest/prom", FIRING);
  assert.equal(r.statusCode, 202);
  assert.equal((await app.inject({ method: "GET", url: "/connectors" })).statusCode, 401);
  const list = await app.inject({ method: "GET", url: "/connectors", headers: { authorization: `Bearer ${API}` } });
  assert.deepEqual(list.json(), { connectors: [{ id: "prom", type: "alertmanager", capabilities: ["ingest"], ingestPath: "/ingest/prom" }] });
  assert.equal((await app.inject({ method: "GET", url: "/ingest/alerts" })).statusCode, 401);
  const alerts = await app.inject({ method: "GET", url: "/ingest/alerts?limit=1", headers: { authorization: `Bearer ${API}` } });
  assert.equal(alerts.json().alerts.length, 1);
  assert.equal((await app.inject({ method: "GET", url: "/ingest/alerts?limit=0", headers: { authorization: `Bearer ${API}` } })).statusCode, 400);
  assert.deepEqual(findSecretOccurrences([
    { name: "responses", text: [r.body, list.body, alerts.body].join("\n") },
    { name: "logs", text: c.logs.join("\n") },
  ], [TOKEN, API]), []);
});

test("without a copilot config every ingest call is 404 and /connectors is empty", async () => {
  const c = createTestContainer();
  const app = buildServer(c);
  assert.equal((await post(app, "/ingest/prom", FIRING)).statusCode, 404);
  assert.deepEqual((await app.inject({ method: "GET", url: "/connectors" })).json(), { connectors: [] });
});

test("npm start refuses ingest connectors with the fake provider and an invalid copilot config (AC-55, AC-51)", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runNode } = await import("../helpers/spawn.ts");
  const dir = mkdtempSync(join(tmpdir(), "ic-start-"));
  try {
    const file = join(dir, "copilot.yaml");
    writeFileSync(file, yaml());
    const fake = await runNode(["src/index.ts"], { COPILOT_CONFIG: file, AM_TOKEN: TOKEN, LLM_PROVIDER: "fake", DB_PATH: ":memory:", PORT: "39999" });
    assert.equal(fake.code, 1);
    const line = JSON.parse(fake.stderr.trim().split("\n").at(-1)!);
    assert.equal(line.msg, "invalid copilot config");
    assert.match(line.problems[0].rule, /LLM_PROVIDER=openrouter/);
    const unset = await runNode(["src/index.ts"], { COPILOT_CONFIG: file, LLM_PROVIDER: "fake", DB_PATH: ":memory:", PORT: "39999" });
    assert.equal(unset.code, 1);
    assert.match(unset.stderr, /environment variable AM_TOKEN is not set/);
    assert.ok(!fake.stderr.includes(TOKEN) && !unset.stderr.includes(TOKEN));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recoverQueued re-enqueues the rows still queued; a job that is not queued any more is a no-op", async () => {
  const { c, app } = setup();
  await post(app, "/ingest/prom", FIRING);
  assert.equal(c.alertQueue.size(), 2);
  assert.equal(c.ingest.recoverQueued(), 2);
  assert.equal(c.alertQueue.size(), 4);
  c.store.updateIngestedAlert("ALR-0001", { outcome: "ignored" });
  await c.incidents.handleAlertJob("ALR-0001");
  await c.incidents.handleAlertJob("ALR-9999");
  assert.equal(c.store.getIngestedAlert("ALR-0001")!.outcome, "ignored");
  assert.equal(c.store.listIncidents({ limit: 5 }).length, 0);
});

test("a secret in a long unmatched path is redacted before clipping, in the 404 body and the access log", async () => {
  const { c, app } = setup();
  for (const pad of [70, 170]) {
    const r = await app.inject({ method: "GET", url: `/nowhere/${"p".repeat(pad)}/${TOKEN}/x` });
    assert.equal(r.statusCode, 404);
    assert.ok(!r.body.includes(TOKEN.slice(0, 10)), `no token prefix in the 404 body (pad ${pad})`);
  }
  assert.ok(!c.logs.join("\n").includes(TOKEN.slice(0, 10)), "no token prefix in the logs");
});

test("trustProxy as a hop count: a spoofed leftmost X-Forwarded-For does not pass the IP allowlist", async () => {
  const auth = 'type: bearer, token: "\${AM_TOKEN}", allowedIps: ["203.0.113.9"]';
  const hit = (app: ReturnType<typeof buildServer>, remoteAddress: string, xff?: string) =>
    app.inject({
      method: "POST", url: "/ingest/prom", payload: JSON.stringify({ alerts: [] }), remoteAddress,
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...(xff ? { "x-forwarded-for": xff } : {}) },
    });
  // One trusted hop (the proxy at 10.0.0.5 appends the address it saw): the rightmost entry is the real client.
  const { app } = setup({ ingest: "ingest: { trustProxy: 1 }", auth });
  assert.equal((await hit(app, "10.0.0.5", "203.0.113.9, 198.51.100.7")).statusCode, 401, "the client forged the allowed address in front of its own");
  assert.equal((await hit(app, "10.0.0.5", "198.51.100.7, 203.0.113.9")).statusCode, 202, "the address the proxy saw is the allowed one");
  // A list of proxy addresses: a forwarded header from anywhere else is ignored.
  const listed = setup({ ingest: 'ingest: { trustProxy: ["10.0.0.0/8"] }', auth }).app;
  assert.equal((await hit(listed, "192.0.2.50", "203.0.113.9")).statusCode, 401, "an untrusted peer cannot set its address");
  assert.equal((await hit(listed, "10.0.0.5", "203.0.113.9")).statusCode, 202);
  // Default (false): the header is never read.
  assert.equal((await hit(setup({ auth }).app, "10.0.0.5", "203.0.113.9")).statusCode, 401);
});

test("a path token of 128 characters reaches the connector (the route param limit matches the schema)", async () => {
  const token = "t".repeat(128);
  const text = `
version: 1
connectors:
  - id: hook
    type: webhook
    ingest:
      auth: { type: path_token, token: "\${PATH_TOK}" }
      mapping: { externalId: id, title: t }
`;
  const copilot = liveCopilot(text, { env: { PATH_TOK: token }, connectors: [webhookConnector] });
  const c = createTestContainer({ copilot, connectorDefinitions: [webhookConnector] });
  for (let i = 0; i < c.config.maxConcurrentRuns; i++) c.runSlots.tryAcquire();
  const server = buildServer(c);
  const hit = (t: string) => server.inject({ method: "POST", url: `/ingest/hook/${t}`, payload: JSON.stringify({ id: "x1", t: "disk full" }), headers: { "content-type": "application/json" } });
  assert.equal((await hit(token)).statusCode, 202);
  assert.equal((await hit("u".repeat(128))).statusCode, 401, "a wrong token of the same length is refused by the connector, not by the router");
  const tooLong = await hit("t".repeat(257));
  assert.deepEqual([tooLong.statusCode, tooLong.json().error.code], [414, "uri_too_long"], "past the router limit: our own error, which never echoes the URL");
  assert.ok(!tooLong.body.includes("tttttttt"));
});
