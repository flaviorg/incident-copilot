// Webhook authentication helpers (spec 008, decision 10; AC-43): every scheme, the IP allowlist first, constant-time
// comparisons, and nothing secret in any outcome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import * as z from "zod";
import { normalizeIp, verifyWebhookAuth, webhookAuthSchema } from "../../src/connectors/shared/auth.ts";
import type { WebhookAuthConfig } from "../../src/connectors/shared/auth.ts";
import { createConfigHelpers } from "../../src/connectors/shared/config-helpers.ts";
import { inboundRequest } from "../helpers/inbound.ts";

const TOKEN = "bearer-" + "t".repeat(30);
const PW = "password-" + "p".repeat(30);
const SECRET = "hmac-" + "s".repeat(30);
const PATH = "PathToken_" + "x".repeat(30);

const body = JSON.stringify({ hello: "world" });
const req = (headers: Record<string, string> = {}, extra: Partial<ReturnType<typeof inboundRequest>> = {}) => ({ ...inboundRequest({ body, headers }), ...extra });
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
const sign = (b: string, secret = SECRET) => createHmac("sha256", secret).update(Buffer.from(b)).digest("hex");

test("bearer: ok, missing, wrong, other scheme; case-insensitive scheme", () => {
  const a: WebhookAuthConfig = { type: "bearer", token: TOKEN };
  assert.deepEqual(verifyWebhookAuth(a, req({ authorization: `Bearer ${TOKEN}` })), { ok: true });
  assert.deepEqual(verifyWebhookAuth(a, req({ authorization: `bearer ${TOKEN}` })), { ok: true });
  assert.deepEqual(verifyWebhookAuth(a, req()), { ok: false, reason: "missing_credentials" });
  assert.deepEqual(verifyWebhookAuth(a, req({ authorization: "Bearer nope" })), { ok: false, reason: "invalid_credentials" });
  assert.deepEqual(verifyWebhookAuth(a, req({ authorization: TOKEN })), { ok: false, reason: "missing_credentials" });
});

test("basic compares user:password as a whole", () => {
  const a: WebhookAuthConfig = { type: "basic", username: "am", password: PW };
  assert.deepEqual(verifyWebhookAuth(a, req({ authorization: basic("am", PW) })), { ok: true });
  assert.equal(verifyWebhookAuth(a, req({ authorization: basic("other", PW) })).ok, false);
  assert.equal(verifyWebhookAuth(a, req({ authorization: basic("am", "x") })).ok, false);
  assert.deepEqual(verifyWebhookAuth(a, req({ authorization: "Basic !!!" })), { ok: false, reason: "missing_credentials" });
});

test("custom header and path token", () => {
  const h: WebhookAuthConfig = { type: "header", name: "x-webhook-secret", value: TOKEN };
  assert.deepEqual(verifyWebhookAuth(h, req({ "X-Webhook-Secret": TOKEN })), { ok: true });
  assert.deepEqual(verifyWebhookAuth(h, req({ "x-webhook-secret": "wrong" })), { ok: false, reason: "invalid_credentials" });
  assert.deepEqual(verifyWebhookAuth(h, req()), { ok: false, reason: "missing_credentials" });
  const p: WebhookAuthConfig = { type: "path_token", token: PATH };
  assert.deepEqual(verifyWebhookAuth(p, req({}, { pathToken: PATH })), { ok: true });
  assert.deepEqual(verifyWebhookAuth(p, req({}, { pathToken: PATH.slice(1) })), { ok: false, reason: "invalid_credentials" });
  assert.deepEqual(verifyWebhookAuth(p, req()), { ok: false, reason: "missing_credentials" });
});

test("hmac over the raw bytes, with prefix and encodings", () => {
  const a: WebhookAuthConfig = { type: "hmac", header: "sentry-hook-signature", secret: SECRET, algorithm: "sha256", encoding: "hex", prefix: "" };
  assert.deepEqual(verifyWebhookAuth(a, req({ "sentry-hook-signature": sign(body) })), { ok: true });
  assert.deepEqual(verifyWebhookAuth(a, req({ "sentry-hook-signature": sign(body).toUpperCase() })), { ok: true });
  assert.deepEqual(verifyWebhookAuth(a, req({ "sentry-hook-signature": sign(body + " ") })), { ok: false, reason: "invalid_signature" });
  assert.deepEqual(verifyWebhookAuth(a, req({ "sentry-hook-signature": sign(body, "other-secret") })), { ok: false, reason: "invalid_signature" });
  assert.deepEqual(verifyWebhookAuth(a, req()), { ok: false, reason: "missing_credentials" });
  const prefixed: WebhookAuthConfig = { ...a, header: "x-hub-signature-256", prefix: "sha256=" };
  assert.deepEqual(verifyWebhookAuth(prefixed, req({ "x-hub-signature-256": `sha256=${sign(body)}` })), { ok: true });
  assert.deepEqual(verifyWebhookAuth(prefixed, req({ "x-hub-signature-256": sign(body) })), { ok: false, reason: "invalid_signature" });
  const b64: WebhookAuthConfig = { ...a, algorithm: "sha1", encoding: "base64" };
  const sig = createHmac("sha1", SECRET).update(Buffer.from(body)).digest("base64");
  assert.deepEqual(verifyWebhookAuth(b64, req({ "sentry-hook-signature": sig })), { ok: true });
});

test("the IP allowlist is checked first, with IPv4-mapped addresses normalized", () => {
  const a: WebhookAuthConfig = { type: "bearer", token: TOKEN, allowedIps: ["10.0.0.5", "2001:db8::1"] };
  const ok = { authorization: `Bearer ${TOKEN}` };
  assert.deepEqual(verifyWebhookAuth(a, req(ok, { remoteAddress: "10.0.0.5" })), { ok: true });
  assert.deepEqual(verifyWebhookAuth(a, req(ok, { remoteAddress: "::ffff:10.0.0.5" })), { ok: true });
  assert.deepEqual(verifyWebhookAuth(a, req(ok, { remoteAddress: "2001:db8::1" })), { ok: true });
  assert.deepEqual(verifyWebhookAuth(a, req({}, { remoteAddress: "10.0.0.6" })), { ok: false, reason: "ip_not_allowed" });
  assert.equal(normalizeIp("::FFFF:192.168.0.1"), "192.168.0.1");
});

test("webhookAuthSchema accepts only the listed kinds and resolves secrets from the environment", () => {
  const sink: string[] = [];
  const env = { T: TOKEN, P: PW, H: SECRET, PT: PATH, SHORTPATH: "short-path-token-123456" };
  const h = createConfigHelpers(env, sink);
  const s = webhookAuthSchema(h, ["bearer", "basic"]);
  assert.deepEqual(s.parse({ type: "bearer", token: "${T}" }), { type: "bearer", token: TOKEN });
  assert.equal(s.safeParse({ type: "hmac", header: "x", secret: "${H}" }).success, false);
  assert.equal(s.safeParse({ type: "bearer", token: TOKEN }).success, false, "a literal secret is refused");
  const all = webhookAuthSchema(h, ["bearer", "basic", "header", "path_token", "hmac"]);
  assert.deepEqual(all.parse({ type: "hmac", header: "x-sig", secret: "${H}" }), { type: "hmac", header: "x-sig", secret: SECRET, algorithm: "sha256", encoding: "hex", prefix: "" });
  assert.equal(all.safeParse({ type: "header", name: "Host", value: "${T}" }).success, false);
  assert.equal(all.safeParse({ type: "header", name: "content-length", value: "${T}" }).success, false);
  assert.equal(all.safeParse({ type: "path_token", token: "${PT}" }).success, true);
  assert.equal(all.safeParse({ type: "path_token", token: "${SHORTPATH}" }).success, false);
  assert.equal(all.safeParse({ type: "bearer", token: "${T}", allowedIps: ["10.0.0.0/8"] }).success, false, "no CIDR in 0.4");
  assert.equal(all.safeParse({ type: "bearer", token: "${T}", extra: 1 }).success, false);
  assert.ok(sink.includes(TOKEN) && sink.includes(SECRET));
  assert.ok(z.toJSONSchema !== undefined);
});

test("outcomes never carry a credential", () => {
  const configs: WebhookAuthConfig[] = [
    { type: "bearer", token: TOKEN }, { type: "basic", username: "am", password: PW },
    { type: "hmac", header: "x-sig", secret: SECRET, algorithm: "sha256", encoding: "hex", prefix: "" },
  ];
  const text = JSON.stringify(configs.map((c) => verifyWebhookAuth(c, req({ authorization: `Bearer ${TOKEN}x`, "x-sig": "00" }))));
  for (const s of [TOKEN, PW, SECRET]) assert.ok(!text.includes(s));
});
