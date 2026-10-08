import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson } from "../../src/domain/canonical-json.ts";
import { ConflictError, LlmUnavailableError } from "../../src/domain/errors.ts";

test("sorts keys recursively without spaces", () =>
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } }), '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}'));
test("normalizes -0 and omits undefined in objects", () => {
  assert.equal(canonicalJson(-0), "0");
  assert.equal(canonicalJson({ x: undefined, y: 1 }), '{"y":1}');
});
test("rejects non-finite numbers and undefined in arrays", () => {
  assert.throws(() => canonicalJson(Number.NaN)); assert.throws(() => canonicalJson(Infinity)); assert.throws(() => canonicalJson([undefined]));
});
test("strings use JSON escaping", () => assert.equal(canonicalJson("ação\n\"x\""), JSON.stringify("ação\n\"x\"")));
test("errors carry stable codes", () => {
  assert.equal(new ConflictError("approval_expired", "m").code, "approval_expired");
  assert.ok(new LlmUnavailableError("m") instanceof Error);
});
