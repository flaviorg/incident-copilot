// Sentry connector, query side (docs/connectors/sentry.md): URLs, the Bearer header, the release fallback and the
// rate-limit mapping. Every route is a fake; nothing touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sentryConnector } from "../../src/connectors/sentry/index.ts";
import { createConnectorInstance } from "../../src/connectors/registry.ts";
import { ConnectorError } from "../../src/connectors/shared/errors.ts";
import { createHttpClient } from "../../src/connectors/shared/http.ts";
import { DeployRecordSchema, ErrorEventSchema, ErrorGroupSchema, ReleaseCommitSchema } from "../../src/contracts/index.ts";
import { parseCopilotConfig } from "../../src/infra/copilot-config/load.ts";
import { createLogger } from "../../src/infra/logger.ts";
import type { QueryCapability, QueryIO } from "../../src/connectors/types.ts";
import { createFakeFetch } from "../helpers/fake-fetch.ts";
import type { FakeRoute } from "../helpers/fake-fetch.ts";

const TOKEN = "sentry-token-" + "t".repeat(32);
const NOW = new Date("2026-10-04T10:00:00.000Z");
const DIR = "tests/fixtures/connectors/sentry/";
const json = (name: string) => JSON.parse(readFileSync(`${DIR}${name}`, "utf8")) as unknown;
const IO: QueryIO = { signal: new AbortController().signal, now: NOW };
const WINDOW = { from: new Date(NOW.getTime() - 3_600_000), to: NOW };
const SINCE = new Date("2026-10-01T00:00:00.000Z");

const PROJECT_URL = "https://sentry.io/api/0/projects/acme/checkout-web/";
const ISSUES = /^https:\/\/sentry\.io\/api\/0\/projects\/acme\/checkout-web\/issues\/\?/;
const RELEASES = /^https:\/\/sentry\.io\/api\/0\/organizations\/acme\/releases\/\?/;

function build(routes: FakeRoute[], query: Record<string, unknown> = {}) {
  const doc = JSON.stringify({ version: 1, connectors: [{ id: "sentry-prod", type: "sentry", query: { organization: "acme", token: "${T}", ...query } }] });
  const r = parseCopilotConfig(doc, { format: "json", env: { T: TOKEN }, connectors: [sentryConnector], notifiers: [] });
  assert.ok(r.ok, JSON.stringify(!r.ok && r.problems));
  const { fetch, calls } = createFakeFetch(routes);
  const instance = createConnectorInstance(sentryConnector, r.config.connectors[0]!, {
    http: createHttpClient({ fetch }), fetch, now: () => NOW, logger: createLogger({ level: "error", secrets: [TOKEN], write: () => {} }),
  });
  const q: QueryCapability = instance.query!;
  return { q, calls };
}

test("errors: project issues URL, Bearer token and the ErrorGroup mapping", async () => {
  const { q, calls } = build([{ url: ISSUES, body: json("api-project-issues.json") }]);
  const groups = await q.errors!({ service: "checkout-web", window: WINDOW, limit: 5 }, IO);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(`${url.origin}${url.pathname}`, "https://sentry.io/api/0/projects/acme/checkout-web/issues/");
  assert.equal(url.searchParams.get("query"), "is:unresolved");
  assert.equal(url.searchParams.get("statsPeriod"), "24h");
  assert.equal(url.searchParams.has("environment"), false);
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0]!.headers.accept, "application/json");
  assert.equal(groups.length, 3);
  for (const g of groups) ErrorGroupSchema.parse(g);
  assert.deepEqual(groups[0], {
    id: "4815162342", title: "TypeError: Cannot read properties of undefined (reading 'total')", culprit: "CartSummary(app/checkout/cart-summary)",
    level: "error", status: "unresolved", count: 1523, userCount: 311, firstSeen: "2026-10-04T09:41:30.000Z", lastSeen: "2026-10-04T09:52:10.000Z",
    release: "checkout-web@2026.10.04-1", url: "https://acme.sentry.io/issues/4815162342/",
  });
  assert.doesNotMatch(groups[1]!.title, /<<<|>>>/, "titles are sanitized");
  assert.deepEqual([groups[2]!.count, groups[2]!.firstSeen, groups[2]!.culprit, groups[2]!.release, groups[2]!.url], [null, null, null, null, null], "unreadable fields become null");
});

test("errors: a configured environment and baseUrl reach the URL", async () => {
  const { q, calls } = build([{ url: /^https:\/\/de\.sentry\.io\/api\/0\/projects\/acme\/checkout-web\/issues\/\?/, body: json("api-project-issues.json") }], { environment: "production", baseUrl: "https://de.sentry.io/" });
  assert.equal((await q.errors!({ service: "checkout-web", window: WINDOW, limit: 2 }, IO)).length, 2);
  const url = new URL(calls[0]!.url);
  assert.equal(url.host, "de.sentry.io");
  assert.equal(url.pathname, "/api/0/projects/acme/checkout-web/issues/", "no double slash after a trailing slash in baseUrl");
  assert.equal(url.searchParams.get("environment"), "production");
});

test("errors: an unsafe slug is refused before any request; a non-array body is a bad response", async () => {
  const { q, calls } = build([{ url: /.*/, body: { detail: "nope" } }]);
  for (const service of ["../../admin", "a/b", "x?y=1", "", "a b"]) {
    await assert.rejects(q.errors!({ service, window: WINDOW, limit: 5 }, IO), (e: unknown) => e instanceof ConnectorError && e.kind === "unsafe_input", service);
  }
  assert.equal(calls.length, 0);
  await assert.rejects(q.errors!({ service: "checkout-web", window: WINDOW, limit: 5 }, IO), (e: unknown) => e instanceof ConnectorError && e.kind === "bad_response");
});

test("deploys: resolves the numeric project id once, then lists its releases newest first (other projects' releases are dropped)", async () => {
  const { q, calls } = build([
    { url: PROJECT_URL, body: json("api-project.json") },
    { url: RELEASES, body: json("api-releases.json") },
  ]);
  const deploys = await q.deploys!({ service: "checkout-web", since: SINCE }, IO);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, PROJECT_URL);
  const url = new URL(calls[1]!.url);
  assert.equal(url.pathname, "/api/0/organizations/acme/releases/");
  assert.equal(url.searchParams.get("project"), "6502112");
  assert.equal(url.searchParams.get("per_page"), "10");
  assert.equal(url.searchParams.has("environment"), false);
  for (const c of calls) assert.equal(c.headers.authorization, `Bearer ${TOKEN}`);
  for (const d of deploys) DeployRecordSchema.parse(d);
  assert.deepEqual(deploys.map((d) => [d.version, d.at, d.environment]), [
    ["checkout-web@2026.10.04-1", "2026-10-04T09:38:00.000Z", "production"],
    ["checkout-web@2026.10.03-2", "2026-10-03T14:10:00.000Z", null],
  ]);
  assert.deepEqual([deploys[0]!.author, deploys[0]!.description, deploys[0]!.url], [null, null, null]);
  await q.deploys!({ service: "checkout-web", since: SINCE }, IO);
  assert.equal(calls.filter((c) => c.url === PROJECT_URL).length, 1, "the project id is cached");
});

test("deploys: environment is sent when configured; since filters old releases", async () => {
  const { q, calls } = build([
    { url: PROJECT_URL, body: json("api-project.json") },
    { url: RELEASES, body: json("api-releases.json") },
  ], { environment: "production" });
  const deploys = await q.deploys!({ service: "checkout-web", since: new Date("2026-10-04T09:30:00.000Z") }, IO);
  assert.equal(new URL(calls[1]!.url).searchParams.get("environment"), "production");
  assert.deepEqual(deploys.map((d) => d.version), ["checkout-web@2026.10.04-1"]);
});

test("deploys: when the project id cannot be resolved, list without project and keep releases of the slug", async () => {
  const { q, calls } = build([
    { url: PROJECT_URL, status: 404, body: { detail: "The requested resource does not exist" } },
    { url: RELEASES, body: json("api-releases.json") },
  ]);
  const deploys = await q.deploys!({ service: "checkout-web", since: SINCE }, IO);
  const url = new URL(calls[1]!.url);
  assert.equal(url.searchParams.has("project"), false);
  assert.equal(url.searchParams.get("per_page"), "100");
  assert.deepEqual(deploys.map((d) => d.version), ["checkout-web@2026.10.04-1", "checkout-web@2026.10.03-2"]);
  await q.deploys!({ service: "checkout-web", since: SINCE }, IO);
  assert.equal(calls.filter((c) => c.url === PROJECT_URL).length, 2, "a failed resolution is retried next time");
});

test("deploys: an auth failure while resolving the project is not swallowed", async () => {
  const { q } = build([{ url: PROJECT_URL, status: 403, body: { detail: "forbidden" } }]);
  await assert.rejects(q.deploys!({ service: "checkout-web", since: SINCE }, IO), (e: unknown) => e instanceof ConnectorError && e.kind === "auth");
});

test("429: Retry-After wins; without it the X-Sentry-Rate-Limit-Reset epoch gives the wait, capped at 3600 s", async () => {
  const epoch = (offsetSec: number) => String(Math.floor(NOW.getTime() / 1000) + offsetSec);
  const attempt = async (headers: Record<string, string>) => {
    const { q } = build([{ url: ISSUES, status: 429, headers, body: { detail: "rate limited" } }]);
    return q.errors!({ service: "checkout-web", window: WINDOW, limit: 5 }, IO).then(() => assert.fail("must reject"), (e: unknown) => {
      assert.ok(e instanceof ConnectorError && e.kind === "rate_limited");
      return e.retryAfterSec;
    });
  };
  assert.equal(await attempt({ "retry-after": "12", "x-sentry-rate-limit-reset": epoch(99) }), 12);
  assert.equal(await attempt({ "x-sentry-rate-limit-reset": epoch(45), "x-sentry-rate-limit-remaining": "0", "x-sentry-rate-limit-limit": "40" }), 45);
  assert.equal(await attempt({ "x-sentry-rate-limit-reset": epoch(86_400) }), 3600);
  assert.equal(await attempt({ "x-sentry-rate-limit-reset": epoch(-30) }), 0);
  assert.equal(await attempt({ "x-sentry-rate-limit-reset": "soon" }), null);
  assert.equal(await attempt({}), null);
});

test("failures never carry the token; other statuses map like the shared client", async () => {
  const kinds: [number, string][] = [[401, "auth"], [403, "auth"], [404, "bad_response"], [500, "unavailable"], [503, "unavailable"]];
  for (const [status, kind] of kinds) {
    const { q } = build([{ url: ISSUES, status, body: { detail: `bad ${TOKEN}` } }]);
    await assert.rejects(q.errors!({ service: "checkout-web", window: WINDOW, limit: 5 }, IO), (e: unknown) => {
      assert.ok(e instanceof ConnectorError);
      assert.equal(e.kind, kind, String(status));
      assert.ok(!`${e.message}${String(e.stack)}`.includes(TOKEN));
      return true;
    });
  }
});

// ---- errorEvent and releaseCommit (spec 009, decision 5; AC-62, AC-63, AC-80) -------------------------------------

const ISSUE_URL = "https://sentry.io/api/0/organizations/acme/issues/4815162342/";
const EVENT_URL = "https://sentry.io/api/0/organizations/acme/issues/4815162342/events/latest/";
const RELEASE_URL = "https://sentry.io/api/0/organizations/acme/releases/checkout-web%402026.10.04-1/";
const SHA = "3f786850e387550fdab836ed7e6dc881de23001b";

function buildLogged(routes: FakeRoute[], o: { timeoutMs?: number } = {}) {
  const doc = JSON.stringify({ version: 1, connectors: [{ id: "sentry-prod", type: "sentry", query: { organization: "acme", token: "${T}" } }] });
  const r = parseCopilotConfig(doc, { format: "json", env: { T: TOKEN }, connectors: [sentryConnector], notifiers: [] });
  assert.ok(r.ok);
  const { fetch, calls } = createFakeFetch(routes);
  const logs: string[] = [];
  const instance = createConnectorInstance(sentryConnector, r.config.connectors[0]!, {
    http: createHttpClient({ fetch, ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}) }), fetch, now: () => NOW,
    logger: createLogger({ level: "debug", secrets: [TOKEN], write: (l) => void logs.push(l) }),
  });
  return { q: instance.query!, calls, logs };
}

const kindIs = (kind: string) => (e: unknown) => e instanceof ConnectorError && e.kind === kind;

test("errorEvent: reads the issue and its latest event on the org path and maps release, firstSeen, the last exception and the frames", async () => {
  const { q, calls } = buildLogged([{ url: ISSUE_URL, body: json("api-issue-detail.json") }, { url: EVENT_URL, body: json("api-event-latest.json") }]);
  const ev = await q.errorEvent!({ service: "checkout-web", errorId: "4815162342" }, IO);
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [["GET", ISSUE_URL], ["GET", EVENT_URL]]);
  for (const c of calls) assert.equal(c.headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(ev);
  ErrorEventSchema.parse(ev);
  assert.equal(ev.errorId, "4815162342");
  assert.equal(ev.release, "checkout-web@2026.10.04-1");
  assert.equal(ev.firstSeen, "2026-10-04T09:41:30.000Z");
  assert.equal(ev.exception.type, "TypeError", "the last exception value is the one raised");
  assert.match(ev.exception.value, /^Cannot read properties of undefined \(reading 'total'\)/);
  assert.doesNotMatch(ev.exception.value, /<<<|>>>|\t/, "the value is sanitized");
  assert.deepEqual(ev.frames, [
    { file: "node:internal/process/task_queues", line: 95, column: 5, function: "processTicksAndRejections", inApp: false },
    { file: "node_modules/express/lib/router/layer.js", line: 95, column: 5, function: "Layer.handle", inApp: false },
    { file: "/srv/app/src/checkout/routes.ts", line: 41, column: 18, function: "handleCheckout", inApp: true },
    { file: "src/checkout/cart-summary.ts", line: 27, column: 22, function: "summarize", inApp: true },
  ], "filename wins over abs_path, frames without a positive line are dropped, innermost last");
});

test("errorEvent: vars, context lines, request, user, contexts and breadcrumbs never reach the result or the logs", async () => {
  const secret = "sk-or-v1-" + "a".repeat(40);
  const event = json("api-event-latest.json") as { entries: { type: string; data: Record<string, unknown> }[]; user: Record<string, unknown>; contexts: Record<string, unknown> };
  const exc = event.entries[0]!.data.values as { stacktrace: { frames: Record<string, unknown>[] } }[];
  for (const f of exc[1]!.stacktrace.frames) {
    f.vars = { token: secret };
    f.context_line = `const key = "${secret}";`;
    f.pre_context = [secret];
    f.post_context = [secret];
  }
  event.entries[1]!.data.values = [{ category: "http", message: `Authorization: Bearer ${secret}` }];
  event.entries[2]!.data.headers = [["Authorization", `Bearer ${secret}`]];
  event.user.email = secret;
  event.contexts.secret = { value: secret };
  const { q, logs } = buildLogged([{ url: ISSUE_URL, body: json("api-issue-detail.json") }, { url: EVENT_URL, body: event }]);
  const ev = await q.errorEvent!({ service: "checkout-web", errorId: "4815162342" }, IO);
  assert.ok(ev);
  assert.ok(!JSON.stringify(ev).includes(secret), "the result never carries an unread field");
  assert.ok(!logs.join("\n").includes(secret) && !logs.join("\n").includes(TOKEN));
});

test("errorEvent: an errorId outside ^\\d{1,20}$ or an unsafe service is refused before any request", async () => {
  const { q, calls } = buildLogged([{ url: /.*/, body: {} }]);
  for (const errorId of ["", "12a", "../1", "1/2", "123456789012345678901", " 1", "1?x=2", "１２"]) {
    await assert.rejects(q.errorEvent!({ service: "checkout-web", errorId }, IO), kindIs("unsafe_input"), errorId);
  }
  await assert.rejects(q.errorEvent!({ service: "../x", errorId: "12345" }, IO), kindIs("unsafe_input"));
  assert.equal(calls.length, 0);
});

test("errorEvent: oversized, malformed, 401, 429 and timeout map to ConnectorError kinds; 404 and no exception give null", async () => {
  const big = JSON.stringify({ id: "12345", pad: "x".repeat(1_100_000) });
  const cases: [FakeRoute[], string][] = [
    [[{ url: /issues\/12345\/$/, body: big }], "bad_response"],
    [[{ url: /issues\/12345\/$/, body: "{not json" }], "bad_response"],
    [[{ url: /issues\/12345\/$/, body: [] }], "bad_response"],
    [[{ url: /issues\/12345\/$/, status: 401, body: { detail: "no" } }], "auth"],
    [[{ url: /issues\/12345\/$/, status: 429, headers: { "retry-after": "5" }, body: {} }], "rate_limited"],
    [[{ url: /issues\/12345\/$/, body: { id: "12345" } }, { url: /events\/latest\/$/, body: "<html>" }], "bad_response"],
    [[{ url: /issues\/12345\/$/, body: { id: "12345" } }, { url: /events\/latest\/$/, status: 503, body: {} }], "unavailable"],
  ];
  for (const [routes, kind] of cases) {
    const { q } = buildLogged(routes);
    await assert.rejects(q.errorEvent!({ service: "checkout-web", errorId: "12345" }, IO), kindIs(kind), kind);
  }
  const slow = buildLogged([{ url: /issues\/12345\/$/, delayMs: 500, body: {} }], { timeoutMs: 20 });
  await assert.rejects(slow.q.errorEvent!({ service: "checkout-web", errorId: "12345" }, IO), kindIs("timeout"));

  const notFound = buildLogged([{ url: /issues\/12345\/$/, status: 404, body: { detail: "not found" } }]);
  assert.equal(await notFound.q.errorEvent!({ service: "checkout-web", errorId: "12345" }, IO), null);
  const noException = buildLogged([{ url: /issues\/12345\/$/, body: { id: "12345", firstSeen: null } }, { url: /events\/latest\/$/, body: { entries: [{ type: "message", data: {} }], tags: [] } }]);
  assert.equal(await noException.q.errorEvent!({ service: "checkout-web", errorId: "12345" }, IO), null);
});

test("errorEvent: an issue of another project gives null; unreadable release and firstSeen become null; at most 50 frames, innermost kept", async () => {
  const other = buildLogged([{ url: /issues\/12345\/$/, body: { id: "12345", project: { slug: "billing-api" } } }, { url: /events\/latest\/$/, body: json("api-event-latest.json") }]);
  assert.equal(await other.q.errorEvent!({ service: "checkout-web", errorId: "12345" }, IO), null);

  const frames = Array.from({ length: 70 }, (_, i) => ({ filename: `src/f${i}.ts`, lineno: i + 1, in_app: "yes", function: 42, colno: -1 }));
  const event = { tags: [{ key: "release", value: 7 }], entries: [{ type: "exception", data: { values: [{ type: "RangeError", stacktrace: { frames } }] } }] };
  const { q } = buildLogged([{ url: /issues\/12345\/$/, body: { id: "12345", firstSeen: "yesterday" } }, { url: /events\/latest\/$/, body: event }]);
  const ev = await q.errorEvent!({ service: "checkout-web", errorId: "12345" }, IO);
  assert.ok(ev);
  ErrorEventSchema.parse(ev);
  assert.deepEqual([ev.release, ev.firstSeen, ev.exception], [null, null, { type: "RangeError", value: "" }]);
  assert.equal(ev.frames.length, 50);
  assert.equal(ev.frames.at(-1)!.file, "src/f69.ts");
  assert.deepEqual(ev.frames[0], { file: "src/f20.ts", line: 21, column: null, function: null, inApp: false }, "in_app must be true, not truthy");
});

test("releaseCommit: URL-encodes the version and maps lastCommit.id and lastCommit.repository.name", async () => {
  const { q, calls } = buildLogged([{ url: RELEASE_URL, body: json("api-release-detail.json") }]);
  const rc = await q.releaseCommit!({ service: "checkout-web", version: "checkout-web@2026.10.04-1" }, IO);
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [["GET", RELEASE_URL]]);
  assert.equal(calls[0]!.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(rc, { sha: SHA, repository: "acme/checkout-web" });
  ReleaseCommitSchema.parse(rc);
});

test("releaseCommit: null without a 40-hex lastCommit.id; repository null when absent; 404 is null", async () => {
  const release = json("api-release-detail.json") as Record<string, unknown>;
  const variants: [unknown, unknown][] = [
    [{ ...release, lastCommit: null }, null],
    [{ ...release, lastCommit: undefined }, null],
    [{ ...release, lastCommit: { id: "abc123" } }, null],
    [{ ...release, lastCommit: { id: SHA.toUpperCase() } }, { sha: SHA, repository: null }],
    [{ ...release, lastCommit: { id: SHA, repository: { name: 7 } } }, { sha: SHA, repository: null }],
    [{ ...release, projects: [{ slug: "billing-api" }] }, null],
  ];
  for (const [body, expected] of variants) {
    const { q } = buildLogged([{ url: RELEASE_URL, body }]);
    assert.deepEqual(await q.releaseCommit!({ service: "checkout-web", version: "checkout-web@2026.10.04-1" }, IO), expected, JSON.stringify(body).slice(0, 80));
  }
  const nf = buildLogged([{ url: RELEASE_URL, status: 404, body: { detail: "not found" } }]);
  assert.equal(await nf.q.releaseCommit!({ service: "checkout-web", version: "checkout-web@2026.10.04-1" }, IO), null);
});

test("releaseCommit: an unsafe version is refused before any request; failures map to ConnectorError kinds", async () => {
  const { q, calls } = buildLogged([{ url: /.*/, body: {} }]);
  for (const version of ["", ".", "..", "a/b", "a b", "a\nb", "x?y", "a#b", "v".repeat(201)]) {
    await assert.rejects(q.releaseCommit!({ service: "checkout-web", version }, IO), kindIs("unsafe_input"), JSON.stringify(version));
  }
  assert.equal(calls.length, 0);
  const cases: [FakeRoute, string][] = [
    [{ url: RELEASE_URL, body: "{" }, "bad_response"],
    [{ url: RELEASE_URL, body: [] }, "bad_response"],
    [{ url: RELEASE_URL, body: JSON.stringify({ pad: "x".repeat(1_100_000) }) }, "bad_response"],
    [{ url: RELEASE_URL, status: 403, body: {} }, "auth"],
    [{ url: RELEASE_URL, status: 429, body: {} }, "rate_limited"],
  ];
  for (const [route, kind] of cases) {
    const b = buildLogged([route]);
    await assert.rejects(b.q.releaseCommit!({ service: "checkout-web", version: "checkout-web@2026.10.04-1" }, IO), kindIs(kind), kind);
  }
  const slow = buildLogged([{ url: RELEASE_URL, delayMs: 500, body: {} }], { timeoutMs: 20 });
  await assert.rejects(slow.q.releaseCommit!({ service: "checkout-web", version: "checkout-web@2026.10.04-1" }, IO), kindIs("timeout"));
});
