// Relator (spec 4.6, 5.7 e 6.1): números por funções puras; o LLM só redige a narrativa de incidente resolvido e um guarda
// numérico descarta texto com número sem origem (AC-23). Incidente escalado recebe relatório parcial pelo template, sem LLM.
// O relator nunca roteia para escalonamento: falha do LLM vira template.
import type {
  Approval, Blackboard, GatedAction, IncidentMetrics, LlmCallRecord, PostmortemDoc, PostmortemNarrative, TraceEvent,
} from "../../contracts/index.ts";
import type { ScenarioRepository, LoadedScenario } from "../../infra/scenarios/scenario-loader.ts";
import type { Clock } from "../../infra/clock.ts";
import type { LlmProvider } from "../../llm/provider.ts";
import { postmortemPrompt } from "../../prompts/v1/index.ts";
import { computeIncidentMetrics, ERROR_RATE_METRIC } from "../../domain/metrics/incident-metrics.ts";
import type { BusinessAssumptions } from "../../domain/metrics/incident-metrics.ts";
import { checkNarrative, collectAllowedNumbers } from "../../domain/report/numeric-guard.ts";
import {
  AGENT_LABELS, ESCALATION_LABELS, formatForNarrative, renderTemplateNarrative,
} from "../../domain/report/postmortem-template.ts";
import { pointsBetween } from "../../domain/telemetry/series.ts";
import { llmInfoOf } from "../../app/trace-sink.ts";
import type { TraceLlmInfo, TraceSink } from "../../app/trace-sink.ts";
import { runContextOf } from "../run-context.ts";
import type { NodeFn } from "../run-context.ts";

export type ReporterReadModel = {
  trace(incidentId: string): TraceEvent[];
  approvals(incidentId: string): Approval[];
  llmCalls(incidentId: string): LlmCallRecord[];
};

export type ReporterDeps = {
  llm: LlmProvider;
  providerName: "fake" | "openrouter";
  trace: TraceSink;
  clock: Clock;
  scenarios: ScenarioRepository;
  assumptions: BusinessAssumptions;
  read: ReporterReadModel;
  savingsFor: (a: GatedAction, bb: Blackboard) => number;
  isMitigating: (actionType: string) => boolean;
};

const EXECUTED: readonly GatedAction["status"][] = ["succeeded", "reverted"];
const TEMPLATE = "template";
const APPROVAL_STATUS_LABELS: Record<Approval["status"], string> = { pending: "pending", approved: "approved", rejected: "rejected", expired: "expired" };
const VERDICT_LABELS: Record<string, string> = { approve: "approved", revise: "asks for revision", reject: "rejected", coerced: "choice corrected", blocked: "blocked" };

/** resolvedAt = horário do último canário saudável no trace; sem ele, agora. */
function resolvedAtOf(events: TraceEvent[], now: Date): string {
  const canary = events.filter((e) => e.type === "critique" && e.payload.by === "canary" && e.payload.verdict === "approve").at(-1);
  return canary?.ts ?? now.toISOString();
}

/** Linha do tempo determinística: só texto gerado por código (sem brief do LLM), a partir do trace e das aprovações. */
function buildTimeline(bb: Blackboard, events: TraceEvent[], approvals: Approval[], impactStartedAt: string): { ts: string; text: string }[] {
  const items: { ts: string; text: string }[] = [
    { ts: impactStartedAt, text: "impact start: first sample above the alert threshold" },
    { ts: bb.alert.detectedAt, text: `alert fired: ${bb.alert.rule}` },
  ];
  for (const e of events) {
    if (e.type === "handoff") items.push({ ts: e.ts, text: `${AGENT_LABELS[e.payload.from]} → ${AGENT_LABELS[e.payload.to]}` });
    else if (e.type === "plan") items.push({ ts: e.ts, text: `plan revision ${e.payload.revision} with ${e.payload.steps.length} ${e.payload.steps.length === 1 ? "step" : "steps"}` });
    else if (e.type === "critique" && e.payload.by === "auditor") items.push({ ts: e.ts, text: `auditor: ${VERDICT_LABELS[e.payload.verdict]}` });
    else if (e.type === "critique" && e.payload.by === "canary") items.push({ ts: e.ts, text: `canary: ${e.payload.feedback}` });
    else if (e.type === "critique" && e.payload.by === "gate") items.push({ ts: e.ts, text: `gate: ${VERDICT_LABELS[e.payload.verdict]}` });
    else if (e.type === "observation" && (e.agent === "executor" || e.agent === "verifier")) {
      items.push({ ts: e.ts, text: `${AGENT_LABELS[e.agent]}: ${e.payload.tool} ${e.payload.ok ? "completed" : "not completed"}` });
    } else if (e.type === "answer" && e.payload.kind === "escalation") {
      items.push({ ts: e.ts, text: `escalated: ${bb.escalation ? ESCALATION_LABELS[bb.escalation.reason] : "reason not recorded"}` });
    }
  }
  for (const a of approvals) {
    const action = bb.actions.find((x) => x.id === a.actionId);
    items.push({ ts: a.requestedAt, text: `approval ${a.id} requested${action ? ` for ${action.actionType}` : ""}` });
    if (a.decidedAt) {
      const by = a.decisionSource === "expiry" ? "by expiry" : a.approver ? `by ${a.approver}` : "";
      items.push({ ts: a.decidedAt, text: `approval ${a.id} ${APPROVAL_STATUS_LABELS[a.status]} ${by}`.trim() });
    }
  }
  return items.map((t, i) => ({ ...t, i })).sort((x, y) => x.ts.localeCompare(y.ts) || x.i - y.i).map(({ ts, text }) => ({ ts, text }));
}

function peakErrorRate(s: LoadedScenario, from: string, to: string): number | null {
  const points = s.series[ERROR_RATE_METRIC];
  if (!points) return null;
  const inside = pointsBetween(points, from, to);
  if (inside.length === 0) return null;
  return Math.round(Math.max(...inside.map((p) => p.value)) * 1e4) / 1e4;
}

function factsOf(m: IncidentMetrics, peak: number | null): string[] {
  const f = [`MTTD: ${formatForNarrative(m.mttdMin)} min (measured)`];
  if (m.mttrMin !== null) f.push(`MTTR: ${formatForNarrative(m.mttrMin)} min (measured, from impact start to verification)`);
  f.push(`time waiting for human approval: ${formatForNarrative(m.timeAwaitingApprovalMin)} min (measured)`);
  if (peak !== null) f.push(`peak 5xx error rate: ${formatForNarrative(peak * 100)}% (measured)`);
  if (m.monthlySavingsUsd > 0) f.push(`monthly savings from executed actions: US$ ${formatForNarrative(m.monthlySavingsUsd, 2)} (derived)`);
  f.push(`synthetic MTTR baseline: ${formatForNarrative(m.baselineMttrMin.low)} to ${formatForNarrative(m.baselineMttrMin.high)} min (illustrative assumption)`);
  return f;
}

export function createReporterNode(d: ReporterDeps): NodeFn {
  return async (state, config) => {
    const ctx = runContextOf(state, config);
    const scenario = d.scenarios.get(state.scenarioId, { offsetSec: state.timeOffsetSec });
    const events = d.read.trace(state.incidentId);
    const approvals = d.read.approvals(state.incidentId);
    const now = d.clock.now();
    const resolved = state.escalation === null && state.verification?.healthy === true;
    const resolvedAt = resolved ? resolvedAtOf(events, now) : null;
    const firstMitigationAt = state.actions
      .filter((a) => EXECUTED.includes(a.status) && a.executedAt !== null && d.isMitigating(a.actionType))
      .map((a) => a.executedAt!)
      .sort()[0] ?? null;
    const metricsInput = {
      alert: state.alert,
      series: scenario.series,
      resolvedAt,
      approvals,
      actions: state.actions,
      category: scenario.file.expectedCategory,
      firstMitigationAt,
      executedSavingsUsd: state.actions.filter((a) => a.status === "succeeded").map((a) => d.savingsFor(a, state)),
      llmCalls: d.read.llmCalls(state.incidentId),
      assumptions: d.assumptions,
    };
    // Métricas para os fatos da narrativa e o guarda numérico; as de LLM são recalculadas depois da chamada do post-mortem.
    let metrics = computeIncidentMetrics(metricsInput);
    const timeline = buildTimeline(state, events, approvals, metrics.impactStartedAt);
    const peak = peakErrorRate(scenario, metrics.impactStartedAt, resolvedAt ?? now.toISOString());
    const pmActions: PostmortemDoc["actions"] = state.actions.map((a) => {
      const ap = a.approvalId ? approvals.find((x) => x.id === a.approvalId) : undefined;
      const decidedBy = ap?.decisionSource === "expiry" ? "expiry" : (ap?.approver ?? null);
      return { actionType: a.actionType, tier: a.tier, status: a.status, decidedBy };
    });
    const status: PostmortemDoc["status"] = resolved ? "final" : "partial";
    const template = () => renderTemplateNarrative({ title: state.alert.title, status, metrics, diagnosis: state.diagnosis, actions: pmActions, escalation: state.escalation });

    let narrative: PostmortemNarrative;
    let generatedBy: PostmortemDoc["generatedBy"] = { provider: d.providerName, model: TEMPLATE, promptVersion: TEMPLATE };
    let numericGuard: PostmortemDoc["numericGuard"] = { passed: true, rejectedNumbers: [], usedTemplate: true };
    let llm: TraceLlmInfo | null = null;

    if (!resolved || state.diagnosis === null) {
      narrative = template();
    } else {
      const r = await d.llm.generate(
        postmortemPrompt,
        {
          kind: "final",
          title: state.alert.title,
          facts: factsOf(metrics, peak),
          timeline,
          diagnosis: state.diagnosis,
          actions: state.actions.map((a) => ({ actionType: a.actionType, status: a.status })),
        },
        ctx,
      );
      if (!r.success) {
        narrative = template();
      } else {
        const allowed = collectAllowedNumbers({
          metrics,
          timeline,
          evidence: state.diagnosis.evidence,
          counts: [state.actions.length, approvals.length, state.diagnosis.evidence.length],
          fractions: peak === null ? [] : [peak],
        });
        const check = checkNarrative([r.data.summary, r.data.rootCauseNarrative, ...r.data.prevention].join("\n"), allowed);
        if (!check.passed) {
          d.trace.emit(ctx, "reporter", { type: "critique", payload: { by: "numeric_guard", verdict: "reject", feedback: `numbers without a source: ${check.rejected.join(", ")}` } }, llmInfoOf(postmortemPrompt, r));
          narrative = template();
          numericGuard = { passed: false, rejectedNumbers: check.rejected, usedTemplate: true };
        } else {
          narrative = r.data;
          generatedBy = { provider: d.providerName, model: r.model, promptVersion: postmortemPrompt.version };
          numericGuard = { passed: true, rejectedNumbers: [], usedTemplate: false };
          llm = llmInfoOf(postmortemPrompt, r);
        }
      }
    }

    // Chamadas, tokens e custo de LLM (medidos) contam também a chamada da narrativa; os demais valores não mudam.
    if (resolved && state.diagnosis !== null) metrics = computeIncidentMetrics({ ...metricsInput, llmCalls: d.read.llmCalls(state.incidentId) });

    const postmortem: PostmortemDoc = {
      incidentId: state.incidentId,
      title: state.alert.title,
      status,
      summary: narrative.summary,
      impact: {
        service: state.alert.service ?? state.alert.account ?? "desconhecido",
        durationMin: metrics.mttrMin,
        peakErrorRate: peak,
        monthlySavingsUsd: metrics.monthlySavingsUsd,
      },
      timeline,
      rootCause: { category: state.diagnosis?.category ?? "unknown", narrative: narrative.rootCauseNarrative, evidence: state.diagnosis?.evidence ?? [] },
      actions: pmActions,
      metrics,
      prevention: narrative.prevention,
      escalation: state.escalation,
      generatedBy,
      numericGuard,
    };
    d.trace.emit(ctx, "reporter", { type: "answer", payload: { kind: "postmortem", text: postmortem.summary } }, llm);
    return { metrics, postmortem, phase: "done" };
  };
}

