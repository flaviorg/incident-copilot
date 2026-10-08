import { test } from "node:test";
import assert from "node:assert/strict";
import { extractNumbers, checkNarrative, collectAllowedNumbers } from "../../src/domain/report/numeric-guard.ts";
import { renderTemplateNarrative, renderPostmortemMarkdown } from "../../src/domain/report/postmortem-template.ts";
import type { TemplateInput } from "../../src/domain/report/postmortem-template.ts";
import { computeIncidentMetrics } from "../../src/domain/metrics/incident-metrics.ts";
import type { IncidentMetrics, PostmortemDoc, SeriesPoint } from "../../src/contracts/index.ts";

// Mesmas entradas do teste de métricas da Tarefa 11 (MTTR 11,1833 min, aprovação de 3 min).
function metrics(): IncidentMetrics {
  const series: SeriesPoint[] = [];
  const start = Date.parse("2026-10-04T09:30:00.000Z");
  for (let t = 0; t <= 2400; t += 30) {
    const ts = new Date(start + t * 1000).toISOString();
    series.push({ ts, value: ts >= "2026-10-04T09:40:30.000Z" ? 0.1 : 0.004 });
  }
  return computeIncidentMetrics({
    alert: { title: "5xx", service: "orders-api", account: null, signal: "http_5xx_rate", threshold: 0.05, rule: "5xx acima de 5% por 2 min", detectedAt: "2026-10-04T09:42:30.000Z", severity: "sev1" },
    series: { http_5xx_rate: series }, resolvedAt: "2026-10-04T09:51:41.000Z",
    approvals: [{ id: "APR-0001", incidentId: "INC-0001", actionId: "ACT-0002", status: "approved", requestedAt: "2026-10-04T09:46:06.000Z", expiresAt: "2026-10-04T10:16:06.000Z", decidedAt: "2026-10-04T09:49:06.000Z", approver: "ana", comment: null, decisionSource: "structured", version: 1 }],
    actions: [], category: "bad_deploy", firstMitigationAt: "2026-10-04T09:49:06.000Z", executedSavingsUsd: [],
    llmCalls: [{ costUsd: 0, promptTokens: 800, completionTokens: 60 }],
    assumptions: { version: "2026-10-04", note: "t", engineersEngaged: 3, engineerHourlyCostUsd: 60, copilotMonthlyCostUsd: 900, incidentsPerMonth: 30, revenuePerMinuteUsd: { "orders-api": 150 }, baselineMttrMin: { bad_deploy: { low: 45, high: 95 } } },
  });
}

function templateInput(): TemplateInput {
  return {
    title: "Taxa de 5xx acima de 5% no orders-api", status: "final", metrics: metrics(),
    diagnosis: {
      hypothesis: "O deploy v3.8.0 introduziu um TypeError em PriceFormatter.format que derrubou cerca de 20% a mais de requisições",
      category: "bad_deploy", confidence: "high", capReached: false,
      evidence: [
        { source: "metrics", ref: "metrics:orders-api:http_5xx_rate@09:13-09:43", summary: "5xx subiu de 0,4% para 9,9% às 09:40:30" },
        { source: "logs", ref: "logs:orders-api:ERROR@09:28-09:43", summary: "380 linhas ERROR de TypeError só na v3.8.0" },
        { source: "deploys", ref: "deploys:orders-api@09:43", summary: "deploy v3.8.0 às 09:40, anterior v3.7.2" },
      ],
    },
    actions: [
      { actionType: "add_incident_note", tier: 2, status: "succeeded", decidedBy: null },
      { actionType: "rollback_deployment", tier: 3, status: "succeeded", decidedBy: "human:ana" },
      { actionType: "block_image_tag", tier: 2, status: "succeeded", decidedBy: null },
    ],
    escalation: null,
  };
}

function doc(): PostmortemDoc {
  const i = templateInput();
  const n = renderTemplateNarrative(i);
  return {
    incidentId: "INC-0001", title: i.title, status: "final", summary: n.summary,
    impact: { service: "orders-api", durationMin: i.metrics.mttrMin, peakErrorRate: 0.0999, monthlySavingsUsd: 0 },
    timeline: [{ ts: "2026-10-04T09:40:30.000Z", text: "início do impacto" }, { ts: "2026-10-04T09:51:41.000Z", text: "canário saudável; incidente resolvido" }],
    rootCause: { category: "bad_deploy", narrative: n.rootCauseNarrative, evidence: i.diagnosis!.evidence },
    actions: i.actions, metrics: i.metrics, prevention: n.prevention, escalation: null,
    generatedBy: { provider: "fake", model: "template", promptVersion: "postmortem.v1" },
    numericGuard: { passed: true, rejectedNumbers: [], usedTemplate: true },
  };
}

test("extracts quantities and ignores identifiers", () =>
  assert.deepEqual(extractNumbers("MTTR de 11,2 min e 9,4% de erro na v3.8.0 às 09:40:30 em i-07ab3").map((n) => n.value), [11.2, 9.4]));
test("ignores ISO timestamps, dates, CVEs, ids and pt-BR thousands parse right", () => {
  assert.deepEqual(extractNumbers("em 2026-10-04T09:40:30.000Z, CVE-2024-3094, INC-0001, vol-0c41d2, 5xx e p99; custo de US$ 1.240,50 e 0.094").map((n) => n.value), [1240.5, 0.094]);
  assert.deepEqual(extractNumbers("houve 20% de melhoria").map((n) => n.raw), ["20%"]);
});
const plain = (values: number[]) => ({ plain: values, percent: [] });

test("invented percentage is rejected", () => assert.deepEqual(checkNarrative("houve 20% de melhoria", { plain: [11.1833, 0.094], percent: [9.4] }), { passed: false, rejected: ["20%"] }));
test("percent and fraction forms are equivalent for fractions", () => {
  const allowed = collectAllowedNumbers({ metrics: metrics(), timeline: [], evidence: [], counts: [], fractions: [0.094] });
  assert.equal(checkNarrative("erro médio de 9,4%", allowed).passed, true);
  assert.equal(checkNarrative("erro médio de 0,094", allowed).passed, true);
});
test("relative tolerance of 0.5%", () => {
  assert.equal(checkNarrative("MTTR de 11,2 min", plain([11.1833])).passed, true);
  assert.equal(checkNarrative("MTTR de 11 min", plain([11.1833])).passed, false);
});
test("scale equivalence (x100, /100) only for fractions and numbers written as percentages", () => {
  const i = templateInput();
  // Contagens 3, 1 e 3 (ações, aprovações, evidências), linha de base 45 a 95 e MTTR 11,18: nenhum vira porcentagem.
  const allowed = collectAllowedNumbers({ metrics: i.metrics, timeline: [], evidence: i.diagnosis!.evidence, counts: [3, 1, 3], fractions: [0.0999] });
  for (const bad of ["300%", "100%", "0,03", "45%", "0,45", "0,95", "1.118%"]) assert.equal(checkNarrative(`valor de ${bad} no texto`, allowed).passed, false, bad);
  const impact = `${String(Math.round(i.metrics.impactFraction * 1000) / 10).replace(".", ",")}%`;
  for (const ok of [impact, "9,99%", "0,0999", "9,9%", "0,099", "0,4%", "45 min", "3 ações", "11,2 min"]) assert.equal(checkNarrative(`valor de ${ok} no texto`, allowed).passed, true, ok);
});
test("template narrative passes its own guard", () => {
  const i = templateInput();   // métricas do teste da Tarefa 11
  const n = renderTemplateNarrative(i);
  const allowed = collectAllowedNumbers({ metrics: i.metrics, timeline: [], evidence: i.diagnosis!.evidence, counts: [i.actions.length] });
  assert.equal(checkNarrative([n.summary, n.rootCauseNarrative, ...n.prevention].join(" "), allowed).passed, true);
  assert.match(n.summary, /11,2/);
  assert.doesNotMatch(n.rootCauseNarrative, /20%/); // hipótese com número sem origem fica de fora do template
});
test("markdown has the fixed sections and labels ROI as illustrative", () => {
  const md = renderPostmortemMarkdown(doc());
  for (const h of ["## Resumo", "## Linha do tempo", "## Causa raiz", "## Ações", "## Números", "## Prevenção"]) assert.ok(md.includes(h), h);
  assert.match(md, /ROI.*ilustrativo/);
});
test("markdown names the narrative model without repeating the provider", () => {
  const fake = renderPostmortemMarkdown({ ...doc(), generatedBy: { provider: "fake", model: "fake/scripted", promptVersion: "postmortem.v1" } });
  assert.match(fake, /^- Narrativa: fake\/scripted \(postmortem\.v1\)$/m);
  assert.doesNotMatch(fake, /fake\/fake/);
  const real = renderPostmortemMarkdown({ ...doc(), generatedBy: { provider: "openrouter", model: "anthropic/claude-x", promptVersion: "postmortem.v1" } });
  assert.match(real, /^- Narrativa: openrouter · anthropic\/claude-x \(postmortem\.v1\)$/m);
  assert.match(renderPostmortemMarkdown(doc()), /^- Narrativa: template determinístico$/m);
});
