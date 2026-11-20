// Sentry connector, query side (docs/connectors/sentry.md): URLs, the Bearer header, the release fallback and the
// rate-limit mapping. Every route is a fake; nothing touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sentryConnector } from "../../src/connectors/sentry/index.ts";
import { createConnectorInstance } from "../../src/connectors/registry.ts";
import { ConnectorError } from "../../src/connectors/shared/errors.ts";
import { createHttpClient } from "../../src/connectors/shared/http.ts";
import { DeployRecordSchema, ErrorGroupSchema } from "../../src/contracts/index.ts";
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
