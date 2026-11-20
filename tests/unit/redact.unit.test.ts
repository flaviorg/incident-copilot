import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, collectSecrets } from "../../src/infra/redact.ts";

const S = ["abcdefghijklmnop"];
test("redacts strings", () => assert.equal(redactSecrets("t=abcdefghijklmnop!", S), "t=[REDACTED]!"));
test("redacts nested objects and arrays", () =>
  assert.deepEqual(redactSecrets({ a: ["x abcdefghijklmnop y"], b: { c: "abcdefghijklmnop" }, n: 1, ok: true, z: null }, S),
    { a: ["x [REDACTED] y"], b: { c: "[REDACTED]" }, n: 1, ok: true, z: null }));
test("redacts errors", () => assert.deepEqual(redactSecrets(new Error("bad abcdefghijklmnop"), S), { name: "Error", message: "bad [REDACTED]" }));
test("collectSecrets ignores null and short values", () =>
  assert.deepEqual(collectSecrets({ approvalToken: "1234567", openrouterApiKey: null }), []));

// Review 2026-11: a secret with characters JSON escapes must also be redacted in serialized JSON.
test("redacts the JSON-escaped form of a secret", () => {
  const secret = 'Ab3"x9\\yz-0123456789';
  const serialized = JSON.stringify({ echo: `token ${secret}` });
  assert.ok(!serialized.includes(secret), "precondition: the raw secret is escaped in JSON");
  const out = redactSecrets(serialized, [secret]);
  assert.ok(!out.includes(JSON.stringify(secret).slice(1, -1)));
  assert.deepEqual(JSON.parse(out), { echo: "token [REDACTED]" });
});

test("redactThenClip never leaves a secret prefix at the cut", async () => {
  const { redactThenClip } = await import("../../src/infra/redact.ts");
  const secret = "sk-or-v1-" + "a".repeat(40);
  const text = "x".repeat(480) + secret + " tail";
  const out = redactThenClip(text, 500, [secret]);
  assert.ok(out.length <= 500);
  assert.ok(!out.includes("sk-or-v1-"), out.slice(470));
});

test("collectSecrets includes API_TOKEN", () => {
  const api = "api-token-" + "z".repeat(20);
  assert.ok(collectSecrets({ approvalToken: null, openrouterApiKey: null, apiToken: api }).includes(api));
});
