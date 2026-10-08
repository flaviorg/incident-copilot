import { test } from "node:test";
import assert from "node:assert/strict";
import { mulberry32, materializeSeries, firstViolation, meanBetween } from "../../src/domain/telemetry/series.ts";

test("same seed gives the same sequence", () => { const a = mulberry32(42), b = mulberry32(42); assert.deepEqual([a(), a(), a()], [b(), b(), b()]); });
test("constant and linear segments", () => {
  const pts = materializeSeries({ segments: [{ fromSec: 0, toSec: 60, kind: "constant", value: 1 }, { fromSec: 60, toSec: 120, kind: "linear", startValue: 1, endValue: 3 }] }, new Date("2026-10-04T00:00:00Z"), 30, 120);
  assert.deepEqual(pts.map((p) => p.value), [1, 1, 1, 2, 3]);
  assert.deepEqual(pts.map((p) => p.ts), ["2026-10-04T00:00:00.000Z", "2026-10-04T00:00:30.000Z", "2026-10-04T00:01:00.000Z", "2026-10-04T00:01:30.000Z", "2026-10-04T00:02:00.000Z"]);
});
test("noise is seeded, rates are clamped to [0, 1] and other metrics to >= 0", () => {
  const spec = { segments: [{ fromSec: 0, toSec: 600, kind: "constant" as const, value: 0 }], noise: { amplitude: 0.5, seed: 9 } };
  const a = materializeSeries(spec, new Date("2026-10-04T00:00:00Z"), 60, 600);
  assert.deepEqual(a, materializeSeries(spec, new Date("2026-10-04T00:00:00Z"), 60, 600));
  assert.ok(a.every((p) => p.value >= 0));
  const high = materializeSeries({ segments: [{ fromSec: 0, toSec: 600, kind: "constant", value: 1 }], noise: { amplitude: 0.5, seed: 9 } }, new Date("2026-10-04T00:00:00Z"), 60, 600, { clamp: "unit" });
  assert.ok(high.every((p) => p.value <= 1));
});
test("firstViolation and meanBetween", () => {
  const pts = [
    { ts: "2026-10-04T09:40:00.000Z", value: 0.01 },
    { ts: "2026-10-04T09:40:30.000Z", value: 0.06 },
    { ts: "2026-10-04T09:41:00.000Z", value: 0.1 },
  ];
  assert.equal(firstViolation(pts, 0.05), "2026-10-04T09:40:30.000Z");
  assert.equal(firstViolation(pts, 0.5), null);
  assert.ok(Math.abs(meanBetween(pts, "2026-10-04T09:40:30.000Z", "2026-10-04T09:41:00.000Z")! - 0.08) < 1e-12);
  assert.equal(meanBetween(pts, "2026-10-04T10:00:00.000Z", "2026-10-04T10:10:00.000Z"), null);
});
