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
