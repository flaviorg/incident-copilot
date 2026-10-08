import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeCanary } from "../../src/domain/canary/canary-analyzer.ts";
import type { CanaryCheck } from "../../src/contracts/index.ts";

const checks: CanaryCheck[] = [{ metric: "http_5xx_rate", op: "<=", threshold: 0.05 }, { metric: "p99_latency_ms", op: "<=", baselineFactor: 1.5 }];
test("healthy window", () => {
  const r = analyzeCanary(checks, { metrics: { http_5xx_rate: [0.005, 0.005], p99_latency_ms: [205, 205] } }, { p99_latency_ms: 180 });
  assert.equal(r.healthy, true); assert.deepEqual(r.checks.map((c) => c.limit), [0.05, 270]);
  assert.deepEqual(r.checks.map((c) => c.observed), [0.005, 205]);
});
test("bad window fails", () => assert.equal(analyzeCanary(checks, { metrics: { http_5xx_rate: [0.09], p99_latency_ms: [205] } }, { p99_latency_ms: 180 }).healthy, false));
test("missing metric fails the check", () => assert.equal(analyzeCanary(checks, { metrics: { http_5xx_rate: [0.001] } }, { p99_latency_ms: 180 }).healthy, false));
test("baselineFactor without baseline fails closed", () => assert.equal(analyzeCanary(checks, { metrics: { http_5xx_rate: [0.001], p99_latency_ms: [100] } }, {}).healthy, false));
