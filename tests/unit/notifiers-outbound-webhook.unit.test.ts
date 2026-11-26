// Generic outbound webhook notifier (spec 008, AC-56; docs/connectors/outbound-webhook.md): the shared conformance kit,
// the golden body, the HMAC signature checked with an independent computation, and the outcome mapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { outboundWebhookNotifier } from "../../src/notifiers/outbound-webhook/index.ts";
import { renderOutbound } from "../../src/notifiers/outbound-webhook/render.ts";
import type { NotificationMessage, NotifyOutcome } from "../../src/notifiers/types.ts";
import { APP_VERSION } from "../../src/infra/app-info.ts";
import { createHttpClient } from "../../src/connectors/shared/http.ts";
import { parseCopilotConfig } from "../../src/infra/copilot-config/load.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { describeNotifierConformance } from "../helpers/notifier-conformance.ts";
import { createFakeFetch } from "../helpers/fake-fetch.ts";
import type { FakeRoute } from "../helpers/fake-fetch.ts";
import { sampleNotificationMessage } from "../helpers/notifications.ts";

const URL = "https://hooks.example.com/incident-copilot";
const SECRET_URL = "https://hooks.example.com/t/" + "u".repeat(32);
const SIGNING = "signing-key-" + "s".repeat(24);
const BEARER = "bearer-token-" + "b".repeat(24);
const ENV = { HOOK_URL: URL, HOOK_SECRET_URL: SECRET_URL, HOOK_SIGNING: SIGNING, HOOK_BEARER: BEARER };

const failureFor = (url: string) => (kind: "retryable" | "permanent"): FakeRoute[] => [kind === "retryable" ? { method: "POST", url, status: 502, body: "bad gateway" } : { method: "POST", url, status: 410, body: "gone" }];

describeNotifierConformance(outboundWebhookNotifier, {
  env: ENV,
  entry: { url: "${HOOK_URL}", signingSecret: "${HOOK_SIGNING}", bearerToken: "${HOOK_BEARER}" },
  secrets: [SIGNING, BEARER],
  okRoutes: [{ method: "POST", url: URL, status: 204 }],
  failureRoutes: failureFor(URL),
});

describeNotifierConformance(outboundWebhookNotifier, {
  env: ENV,
  entry: { urlIsSecret: true, secretUrl: "${HOOK_SECRET_URL}" },
  secrets: [SECRET_URL],
  okRoutes: [{ method: "POST", url: SECRET_URL, status: 200, body: "received" }],
  failureRoutes: failureFor(SECRET_URL),
});

type Built = { notifier: ReturnType<typeof outboundWebhookNotifier.create>; calls: ReturnType<typeof createFakeFetch>["calls"] };

function parseEntry(entry: Record<string, unknown>, env: Record<string, string> = ENV) {
  const text = JSON.stringify({ version: 1, notifiers: [{ id: "hook", type: "outbound-webhook", ...entry }] });
  return parseCopilotConfig(text, { format: "json", env, connectors: [], notifiers: [outboundWebhookNotifier] });
}

function build(routes: FakeRoute[], entry: Record<string, unknown> = { url: "${HOOK_URL}" }, env: Record<string, string> = ENV): Built {
  const r = parseEntry(entry, env);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.problems));
  const { fetch, calls } = createFakeFetch(routes);
  const notifier = outboundWebhookNotifier.create(r.config.notifiers[0]!.config, {
    id: "hook",
    http: createHttpClient({ fetch }),
    logger: createLogger({ level: "error", secrets: r.config.secrets, write: () => {} }),
  });
  return { notifier, calls };
}

const send = (b: Built, m: NotificationMessage = sampleNotificationMessage()): Promise<NotifyOutcome> => b.notifier.send(m, { signal: new AbortController().signal });
const ok = (url = URL): FakeRoute => ({ method: "POST", url, status: 200 });

test("the request is a JSON POST and its body matches the golden", async () => {
  const b = build([ok()]);
  assert.deepEqual(await send(b), { ok: true });
  const call = b.calls[0]!;
  assert.equal(call.method, "POST");
  assert.equal(call.url, URL);
  assert.match(call.headers["content-type"]!, /^application\/json/);
  assert.equal(call.headers["user-agent"], `incident-copilot/${APP_VERSION}`);
  assert.deepEqual(JSON.parse(call.body!), JSON.parse(readFileSync("tests/fixtures/notifiers/outbound-analysis-ready.json", "utf8")));
  assert.equal(call.body, JSON.stringify({ schemaVersion: 1, ...sampleNotificationMessage() }));
  assert.equal(call.body, renderOutbound(sampleNotificationMessage()));
});

test("without secrets there is no Authorization and no signature header", async () => {
  const b = build([ok()]);
  await send(b);
  const h = b.calls[0]!.headers;
  assert.equal(h["authorization"], undefined);
  assert.equal(h["x-incident-copilot-signature"], undefined);
  assert.equal(h["x-incident-copilot-timestamp"], undefined);
});

test("the Bearer token is sent as the Authorization header", async () => {
  const b = build([ok()], { url: "${HOOK_URL}", bearerToken: "${HOOK_BEARER}" });
  await send(b);
  assert.equal(b.calls[0]!.headers["authorization"], `Bearer ${BEARER}`);
  assert.ok(!b.calls[0]!.body!.includes(BEARER));
});

test("the signature is sha256= of HMAC-SHA256 over `${timestamp}.${body}`, checked independently", async () => {
  const before = Math.floor(Date.now() / 1000);
  const b = build([ok()], { url: "${HOOK_URL}", signingSecret: "${HOOK_SIGNING}" });
  await send(b);
  const after = Math.floor(Date.now() / 1000);
  const { headers, body } = b.calls[0]!;
  const ts = headers["x-incident-copilot-timestamp"]!;
  assert.match(ts, /^\d{10}$/);
  assert.ok(Number(ts) >= before && Number(ts) <= after, "unix seconds of the send");
  const expected = "sha256=" + createHmac("sha256", SIGNING).update(`${ts}.${body}`).digest("hex");
  assert.equal(headers["x-incident-copilot-signature"], expected);
  assert.match(headers["x-incident-copilot-signature"]!, /^sha256=[0-9a-f]{64}$/);
  // A different key, a different body or a different timestamp does not verify.
  assert.notEqual(headers["x-incident-copilot-signature"], "sha256=" + createHmac("sha256", SIGNING + "x").update(`${ts}.${body}`).digest("hex"));
  assert.notEqual(headers["x-incident-copilot-signature"], "sha256=" + createHmac("sha256", SIGNING).update(`${ts}.${body} `).digest("hex"));
  assert.ok(!body!.includes(SIGNING));
  assert.ok(!JSON.stringify(headers).includes(SIGNING));
});

test("a retry is signed again with its own timestamp (the body is the same)", async () => {
  const b = build([ok()], { url: "${HOOK_URL}", signingSecret: "${HOOK_SIGNING}" });
  await send(b);
  await send(b);
  assert.equal(b.calls[0]!.body, b.calls[1]!.body);
  for (const c of b.calls) {
    const ts = c.headers["x-incident-copilot-timestamp"]!;
    assert.equal(c.headers["x-incident-copilot-signature"], "sha256=" + createHmac("sha256", SIGNING).update(`${ts}.${c.body}`).digest("hex"));
  }
});

test("outcomes: 2xx is ok; 429 and 5xx are retryable and honor Retry-After; network failures are retryable", async () => {
  for (const status of [200, 201, 202, 204]) assert.deepEqual(await send(build([{ method: "POST", url: URL, status }])), { ok: true }, String(status));
  assert.deepEqual(await send(build([{ method: "POST", url: URL, status: 429, headers: { "retry-after": "9" } }])), { ok: false, retryable: true, retryAfterSec: 9, reason: "http 429" });
  assert.deepEqual(await send(build([{ method: "POST", url: URL, status: 429 }])), { ok: false, retryable: true, retryAfterSec: null, reason: "http 429" });
  assert.deepEqual(await send(build([{ method: "POST", url: URL, status: 503, headers: { "retry-after": "3" } }])), { ok: false, retryable: true, retryAfterSec: 3, reason: "http 503" });
  assert.deepEqual(await send(build([{ method: "POST", url: URL, status: 500 }])), { ok: false, retryable: true, retryAfterSec: null, reason: "http 500" });
  assert.deepEqual(await send(build([{ method: "POST", url: URL, error: "network" }])), { ok: false, retryable: true, retryAfterSec: null, reason: "unavailable" });
});

test("outcomes: any other status is permanent with the status in the reason", async () => {
  for (const status of [301, 400, 401, 403, 404, 410, 422]) {
    assert.deepEqual(await send(build([{ method: "POST", url: URL, status, body: "details" }])), { ok: false, retryable: false, retryAfterSec: null, reason: `http ${status}` }, String(status));
  }
});

test("no secret appears in any outcome, even when the receiver echoes it back", async () => {
  const entry = { urlIsSecret: true, secretUrl: "${HOOK_SECRET_URL}", signingSecret: "${HOOK_SIGNING}", bearerToken: "${HOOK_BEARER}" };
  const echo = `${SECRET_URL} ${SIGNING} ${BEARER}`;
  const cases: FakeRoute[] = [
    { method: "POST", url: SECRET_URL, status: 400, body: echo },
    { method: "POST", url: SECRET_URL, status: 500, body: echo },
    { method: "POST", url: SECRET_URL, status: 200, body: echo },
    { method: "POST", url: SECRET_URL, error: "network" },
  ];
  for (const route of cases) {
    const b = build([route], entry);
    const text = JSON.stringify(await send(b));
    for (const s of [SECRET_URL, SIGNING, BEARER, "hooks.example.com", "u".repeat(32)]) assert.ok(!text.includes(s));
    assert.ok(!b.calls[0]!.body!.includes(SIGNING) && !b.calls[0]!.body!.includes(BEARER) && !b.calls[0]!.body!.includes("u".repeat(32)), "the body never carries a configured secret");
  }
});

test("urlIsSecret: the URL given as secretUrl is the one called and joins the redaction list", async () => {
  const r = parseEntry({ urlIsSecret: true, secretUrl: "${HOOK_SECRET_URL}" });
  assert.ok(r.ok && r.config.secrets.includes(SECRET_URL));
  const b = build([ok(SECRET_URL)], { urlIsSecret: true, secretUrl: "${HOOK_SECRET_URL}" });
  assert.deepEqual(await send(b), { ok: true });
  assert.equal(b.calls[0]!.url, SECRET_URL);
});

test("config: https is required, and http only on loopback", () => {
  const withUrl = (u: string) => parseEntry({ url: "${HOOK_URL}" }, { ...ENV, HOOK_URL: u });
  assert.ok(withUrl("https://hooks.example.com/x").ok);
  for (const u of ["http://localhost:8080/hook", "http://127.0.0.1:9000/hook", "http://[::1]:9000/hook"]) assert.ok(withUrl(u).ok, u);
  for (const u of ["http://hooks.example.com/x", "http://10.0.0.5/x", "http://localhost.evil.example/x", "ftp://hooks.example.com/x", "javascript:alert(1)", "https://user:pass@hooks.example.com/x", "not a url"]) {
    const r = withUrl(u);
    assert.ok(!r.ok, u);
    assert.ok(!JSON.stringify(r).includes("hooks.example.com/x") || u.startsWith("not"), "the rejected value is not echoed");
  }
});

test("config: a loopback http URL is delivered", async () => {
  const b = build([{ method: "POST", url: "http://127.0.0.1:9000/hook", status: 200 }], { url: "${HOOK_URL}" }, { ...ENV, HOOK_URL: "http://127.0.0.1:9000/hook" });
  assert.deepEqual(await send(b), { ok: true });
});

test("config: url and secretUrl are exclusive and chosen by urlIsSecret; the secret URL is checked like any URL", () => {
  assert.ok(!parseEntry({}).ok, "a URL is required");
  assert.ok(!parseEntry({ urlIsSecret: true, url: "${HOOK_URL}" }).ok, "a secret URL must use secretUrl");
  assert.ok(!parseEntry({ urlIsSecret: true }).ok);
  assert.ok(!parseEntry({ secretUrl: "${HOOK_SECRET_URL}" }).ok, "secretUrl needs urlIsSecret: true");
  assert.ok(!parseEntry({ url: "${HOOK_URL}", secretUrl: "${HOOK_SECRET_URL}" }).ok);
  assert.ok(!parseEntry({ urlIsSecret: true, secretUrl: "${HOOK_SECRET_URL}" }, { ...ENV, HOOK_SECRET_URL: "http://hooks.example.com/t/" + "u".repeat(32) }).ok, "http outside loopback");
  assert.ok(!parseEntry({ urlIsSecret: true, secretUrl: SECRET_URL }).ok, "a literal secret URL is refused");
  assert.ok(!parseEntry({ url: "${HOOK_URL}", signingSecret: "${HOOK_SIGNING}", unknown: 1 }).ok, "strict keys");
  assert.ok(!parseEntry({ url: "${HOOK_URL}", signingSecret: "${HOOK_SIGNING}" }, { ...ENV, HOOK_SIGNING: "short" }).ok, "signing secret of at least 16 characters");
  assert.ok(!parseEntry({ url: "${HOOK_URL}", bearerToken: "${HOOK_BEARER}" }, { ...ENV, HOOK_BEARER: "short" }).ok, "bearer token of at least 16 characters");
  assert.ok(!parseEntry({ url: "${HOOK_URL}", bearerToken: BEARER }).ok, "secrets are whole ${VAR} references");
});

test("the caller's abort signal ends the send", async () => {
  const b = build([{ ...ok(), delayMs: 5000 }]);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10);
  const out = await b.notifier.send(sampleNotificationMessage(), { signal: ac.signal });
  assert.equal(out.ok, false);
});

test("a code-fix message carries its codeFix object; the 0.4 golden has none (spec 009, AC-83)", async () => {
  const codeFix: NonNullable<NotificationMessage["codeFix"]> = {
    attemptId: "fix_0123456789abcdef", status: "pr_opened", mode: "draft_pr", repo: "acme/checkout-web", baseBranch: "main",
    location: { file: "src/checkout/cart-summary.ts", line: 12 }, exceptionType: "TypeError",
    diff: { added: 10, removed: 1, files: 2 }, testName: "summarize returns zero for a cart without totals",
    evidence: { failedBefore: true, passesAfter: true, suiteTotal: 4, suiteFailed: 0 },
    approval: null, pullRequest: { number: 42, url: "https://github.com/acme/checkout-web/pull/42" },
    links: { approval: null, pullRequest: "https://github.com/acme/checkout-web/pull/42" },
  };
  const m = sampleNotificationMessage({ kind: "code_fix_pr_opened", codeFix });
  const b = build([ok()]);
  assert.deepEqual(await send(b, m), { ok: true });
  const body = JSON.parse(b.calls[0]!.body!);
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.kind, "code_fix_pr_opened");
  assert.deepEqual(body.codeFix, codeFix);
  assert.equal("codeFix" in JSON.parse(renderOutbound(sampleNotificationMessage())), false);
});
