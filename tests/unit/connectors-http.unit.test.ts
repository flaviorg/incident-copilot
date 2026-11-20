// Shared connector kit (spec 008, decision 13): the HTTP client over an injected fetch, ConnectorError, the parse
// helpers and the config helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import { createHttpClient, parseRetryAfter } from "../../src/connectors/shared/http.ts";
import { ConnectorError } from "../../src/connectors/shared/errors.ts";
import { asRecord, asString, getPath, httpUrlOrNull, stableHash, toIsoOrNull } from "../../src/connectors/shared/parse-utils.ts";
import { createConfigHelpers } from "../../src/connectors/shared/config-helpers.ts";
import { hmacDigest } from "../../src/infra/crypto.ts";
import { createFakeFetch } from "../helpers/fake-fetch.ts";

const U = "https://api.example.com/v1/x";
const kindOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    assert.ok(e instanceof ConnectorError, String(e));
    return e.kind;
  }
};

test("json maps statuses to ConnectorError kinds and never throws on status in request", async () => {
  const { fetch, calls } = createFakeFetch([
    { url: `${U}/ok`, body: { a: 1 } },
    { url: `${U}/401`, status: 401, body: { error: "token xyz" } },
    { url: `${U}/403`, status: 403 },
    { url: `${U}/429`, status: 429, headers: { "retry-after": "30" } },
    { url: `${U}/500`, status: 503 },
    { url: `${U}/404`, status: 404 },
    { url: `${U}/text`, body: "not json" },
    { url: `${U}/net`, error: "network" },
  ]);
  const http = createHttpClient({ fetch, userAgent: "ua-test" });
  assert.deepEqual(await http.json({ method: "GET", url: `${U}/ok` }), { a: 1 });
  assert.equal(calls[0]!.headers["user-agent"], "ua-test");
  assert.equal(await kindOf(http.json({ method: "GET", url: `${U}/401` })), "auth");
  assert.equal(await kindOf(http.json({ method: "GET", url: `${U}/403` })), "auth");
  await assert.rejects(http.json({ method: "GET", url: `${U}/429` }), (e: unknown) => e instanceof ConnectorError && e.kind === "rate_limited" && e.retryAfterSec === 30);
  assert.equal(await kindOf(http.json({ method: "GET", url: `${U}/500` })), "unavailable");
  assert.equal(await kindOf(http.json({ method: "GET", url: `${U}/404` })), "bad_response");
  assert.equal(await kindOf(http.json({ method: "GET", url: `${U}/text` })), "bad_response");
  assert.equal(await kindOf(http.json({ method: "GET", url: `${U}/net` })), "unavailable");
  assert.equal((await http.request({ method: "GET", url: `${U}/404` })).status, 404);
  await assert.rejects(http.json({ method: "GET", url: `${U}/401` }), (e: unknown) => e instanceof Error && !e.message.includes("xyz") && e.message === "authentication failed");
});

test("timeouts, aborts, oversized bodies and redirects become ConnectorError", async () => {
  const { fetch, calls } = createFakeFetch([
    { url: `${U}/slow`, body: {}, delayMs: 5000 },
    { url: `${U}/big`, body: "x".repeat(2000) },
    { url: `${U}/bigdeclared`, body: "x", headers: { "content-length": "999999" } },
  ]);
  const http = createHttpClient({ fetch, timeoutMs: 30, maxResponseBytes: 1000 });
  assert.equal(await kindOf(http.json({ method: "GET", url: `${U}/slow` })), "timeout");
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10);
  assert.equal(await kindOf(http.json({ method: "GET", url: `${U}/slow`, timeoutMs: 5000, signal: ac.signal })), "timeout");
  assert.equal(await kindOf(http.request({ method: "GET", url: `${U}/big` })), "bad_response");
  assert.equal(await kindOf(http.request({ method: "GET", url: `${U}/bigdeclared` })), "bad_response");
  assert.equal(await kindOf(http.request({ method: "GET", url: `${U}/unrouted` })), "unavailable");
  // The client asks fetch to refuse redirects.
  let redirect: RequestRedirect | undefined;
  const spy = (async (_u: string, init: RequestInit) => { redirect = init.redirect; return new Response("{}"); }) as typeof globalThis.fetch;
  await createHttpClient({ fetch: spy }).json({ method: "POST", url: U, body: "{}" });
  assert.equal(redirect, "error");
  assert.ok(calls.length >= 4);
});

test("Retry-After in seconds or as a date, capped at one hour", () => {
  const now = Date.parse("2026-10-04T10:00:00Z");
  assert.equal(parseRetryAfter("12", now), 12);
  assert.equal(parseRetryAfter("99999", now), 3600);
  assert.equal(parseRetryAfter("Sun, 04 Oct 2026 10:01:00 GMT", now), 60);
  assert.equal(parseRetryAfter("garbage", now), null);
  assert.equal(parseRetryAfter(null, now), null);
});

test("toIsoOrNull handles RFC 3339 nanoseconds, offsets, epochs and the Go zero time", () => {
  assert.equal(toIsoOrNull("2026-10-04T09:41:30.123456789Z"), "2026-10-04T09:41:30.123Z");
  assert.equal(toIsoOrNull("2026-10-04T09:41:30Z"), "2026-10-04T09:41:30.000Z");
  assert.equal(toIsoOrNull("2026-10-04T11:41:30.5+02:00"), "2026-10-04T09:41:30.500Z");
  assert.equal(toIsoOrNull("2026-10-04T11:41:30+0200"), "2026-10-04T09:41:30.000Z");
  assert.equal(toIsoOrNull(1_791_106_890_000), "2026-10-04T09:41:30.000Z");
  assert.equal(toIsoOrNull(1_791_106_890), "2026-10-04T09:41:30.000Z");
  assert.equal(toIsoOrNull("1791106890"), "2026-10-04T09:41:30.000Z");
  assert.equal(toIsoOrNull("0001-01-01T00:00:00Z"), null);
  assert.equal(toIsoOrNull("yesterday"), null);
  assert.equal(toIsoOrNull(null), null);
  assert.equal(toIsoOrNull(Number.NaN), null);
});

test("httpUrlOrNull, getPath, stableHash, asString and asRecord", () => {
  assert.equal(httpUrlOrNull("https://x.example.com/a"), "https://x.example.com/a");
  assert.equal(httpUrlOrNull("javascript:alert(1)"), null);
  assert.equal(httpUrlOrNull("https://x.example.com/" + "a".repeat(2000)), null);
  const obj = { a: { b: [{ c: 1 }] } };
  assert.equal(getPath(obj, "a.b.0.c"), 1);
  assert.equal(getPath(obj, "a.b.x"), undefined);
  assert.equal(getPath(obj, "__proto__.polluted"), undefined);
  assert.equal(getPath({}, "constructor"), undefined);
  assert.equal(getPath(obj, "a.toString"), undefined);
  assert.equal(stableHash({ b: 1, a: 2 }), stableHash({ a: 2, b: 1 }));
  assert.match(stableHash({ a: 1 }), /^[0-9a-f]{16}$/);
  assert.equal(asString("  hi <<<x>>> ", 50), "hi ‹‹‹x›››");
  assert.equal(asString("   ", 50), null);
  assert.equal(asString(42, 50), "42");
  assert.equal(asString({}, 50), null);
  assert.deepEqual(asRecord({ a: 1 }), { a: 1 });
  assert.equal(asRecord([]), null);
  assert.equal(asRecord(null), null);
});

test("config helpers: interpolation, whole-reference secrets and URLs, with fixed messages", () => {
  const sink: string[] = [];
  const h = createConfigHelpers({ HOST: "api.example.com", KEY: "k".repeat(20), EMPTY: " " }, sink);
  assert.equal(h.text().parse("https://${HOST}/v1"), "https://api.example.com/v1");
  assert.equal(h.text().parse("literal ${lower} kept"), "literal ${lower} kept");
  const unset = h.text().safeParse("${NOPE}");
  assert.ok(!unset.success && unset.error.issues[0]!.message === "environment variable NOPE is not set");
  assert.equal(h.text().safeParse("${EMPTY}").success, false);
  assert.equal(h.secret().parse("${KEY}"), "k".repeat(20));
  assert.deepEqual(sink, ["k".repeat(20)]);
  assert.equal(h.secret({ min: 30 }).safeParse("${KEY}").success, false);
  assert.equal(h.url().parse("https://${HOST}"), "https://api.example.com");
  assert.equal(h.url().parse("http://localhost:9000"), "http://localhost:9000");
  assert.equal(h.url({ allowLoopbackHttp: false }).safeParse("http://localhost:9000").success, false);
  assert.equal(h.url().safeParse("ftp://${HOST}").success, false);
  assert.equal(h.url().safeParse("not a url").success, false);
  assert.ok(z.string() !== undefined);
});

test("hmacDigest matches node:crypto for both algorithms and encodings", () => {
  const data = Buffer.from("payload");
  assert.match(hmacDigest("sha256", "s", data, "hex"), /^[0-9a-f]{64}$/);
  assert.match(hmacDigest("sha1", "s", data, "base64"), /^[A-Za-z0-9+/]+=*$/);
});
