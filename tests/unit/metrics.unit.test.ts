import { test } from "node:test";
import assert from "node:assert/strict";
import { computeIncidentMetrics } from "../../src/domain/metrics/incident-metrics.ts";
import type { BusinessAssumptions, MetricsInput } from "../../src/domain/metrics/incident-metrics.ts";
import type { Alert, Approval, SeriesPoint } from "../../src/contracts/index.ts";

const assertClose = (a: number, b: number, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

const assumptions: BusinessAssumptions = {
  version: "2026-10-04", note: "teste", engineersEngaged: 3, engineerHourlyCostUsd: 60, copilotMonthlyCostUsd: 900, incidentsPerMonth: 30,
  revenuePerMinuteUsd: { "orders-api": 150 }, baselineMttrMin: { bad_deploy: { low: 45, high: 95 }, cost_anomaly: { low: 45, high: 95 } },
};

// Série de teste: 0,004 até 09:40:00 e 0,1 constante desde 09:40:30, a cada 30 s, até 10:10.
function testSeries(): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  const start = Date.parse("2026-10-04T09:30:00.000Z");
  for (let t = 0; t <= 2400; t += 30) {
    const ts = new Date(start + t * 1000).toISOString();
    out.push({ ts, value: ts >= "2026-10-04T09:40:30.000Z" ? 0.1 : 0.004 });
  }
  return out;
}

const deployAlert: Alert = { title: "5xx", service: "orders-api", account: null, signal: "http_5xx_rate", threshold: 0.05, rule: "5xx above 5% for 2 min", detectedAt: "2026-10-04T09:42:30.000Z", severity: "sev1" };

function approvalOf(minutes: number): Approval {
  const requested = Date.parse("2026-10-04T09:46:06.000Z");
  return {
    id: "APR-0001", incidentId: "INC-0001", actionId: "ACT-0002", status: "approved",
    requestedAt: new Date(requested).toISOString(), expiresAt: new Date(requested + 30 * 60000).toISOString(),
    decidedAt: new Date(requested + minutes * 60000).toISOString(), approver: "ana", comment: null, decisionSource: "structured", version: 1,
  };
}

function input(o: { resolvedAt: string | null; firstMitigationAt: string | null; approvalMinutes?: number; executedSavingsUsd?: number[] }): MetricsInput {
  return {
    alert: deployAlert, series: { http_5xx_rate: testSeries() }, resolvedAt: o.resolvedAt,
    approvals: o.approvalMinutes === undefined ? [] : [approvalOf(o.approvalMinutes)], actions: [], category: "bad_deploy",
    firstMitigationAt: o.firstMitigationAt, executedSavingsUsd: o.executedSavingsUsd ?? [],
    llmCalls: [{ costUsd: 0, promptTokens: 800, completionTokens: 60 }, { costUsd: 0, promptTokens: 900, completionTokens: 120 }],
    assumptions,
  };
}

function costInput(o: { executedSavingsUsd: number[] }): MetricsInput {
  return {
    alert: { title: "cost", service: null, account: "data-platform", signal: "daily_cost_usd", threshold: null, rule: "daily cost 41% above the 7-day average", detectedAt: "2026-10-04T08:00:00.000Z", severity: "sev3" },
    series: { daily_cost_usd: [{ ts: "2026-10-04T08:00:00.000Z", value: 23.1 }] }, resolvedAt: "2026-10-04T08:20:00.000Z",
    approvals: [], actions: [], category: "cost_anomaly", firstMitigationAt: "2026-10-04T08:15:00.000Z",
    executedSavingsUsd: o.executedSavingsUsd, llmCalls: [], assumptions,
  };
}

test("deploy-like metrics with ranges and labels", () => {
  const m = computeIncidentMetrics(input({ resolvedAt: "2026-10-04T09:51:41.000Z", firstMitigationAt: "2026-10-04T09:49:06.000Z", approvalMinutes: 3 }));
  assert.equal(m.impactStartedAt, "2026-10-04T09:40:30.000Z"); assert.equal(m.mttdMin, 2);
  assertClose(m.mttrMin!, 11.1833); assert.equal(m.timeAwaitingApprovalMin, 3);
  assertClose(m.minutesSaved!.low, 33.8167); assertClose(m.minutesSaved!.high, 83.8167);
  assertClose(m.impactFraction, 0.1);
  assertClose(m.downtimeCostAvoidedUsd.low, 507.25); assertClose(m.engineeringCostSavedUsd.low, 101.45);
  assert.equal(m.copilotCostUsd, 30); assertClose(m.roiIllustrative!.low, 19.29, 0.01);
  assert.equal(m.sources.mttrMin, "measured"); assert.equal(m.sources.baselineMttrMin, "assumption"); assert.equal(m.sources.roiIllustrative, "derived");
  assert.equal(m.llmCalls, 2); assert.equal(m.promptTokens, 1700); assert.equal(m.completionTokens, 180); assert.equal(m.assumptionsVersion, "2026-10-04");
});
test("unresolved incident has null MTTR, savings and ROI", () => {
  const m = computeIncidentMetrics(input({ resolvedAt: null, firstMitigationAt: null, executedSavingsUsd: [] }));
  assert.equal(m.mttrMin, null); assert.equal(m.minutesSaved, null); assert.equal(m.roiIllustrative, null);
  assert.equal(m.impactFraction, 0); assert.deepEqual(m.downtimeCostAvoidedUsd, { low: 0, high: 0 });
});
test("cost incident: impact equals detection and savings drive ROI", () => {
  const m = computeIncidentMetrics(costInput({ executedSavingsUsd: [60, 3.65, 275.94] }));
  assert.equal(m.impactStartedAt, m.detectedAt); assert.equal(m.impactFraction, 0); assertClose(m.monthlySavingsUsd, 339.59);
  assert.equal(m.revenuePerMinuteUsd, 0); assert.ok(m.roiIllustrative!.low > 0);
});
