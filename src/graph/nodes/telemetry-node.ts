// Analista de telemetria (spec 4.5, 4.6 e 5.1, passo 4): laço ReAct dentro do nó, com teto rígido.
// Nenhum passo do laço é superstep do grafo, então 12 passos não consomem o recursionLimit (motivo de não usar subgrafo).
// Erro de ferramenta vira observação ok: false e o laço continua (221517); falha de LLM vira escalonamento llm_unavailable.
import type { Diagnosis, Evidence, Limits, ReadToolName } from "../../contracts/index.ts";
import type { ScenarioRepository } from "../../infra/scenarios/scenario-loader.ts";
import type { Clock } from "../../infra/clock.ts";
import type { LlmProvider } from "../../llm/provider.ts";
import type { ToolRegistry } from "../../tools/registry.ts";
import { telemetryReactPrompt } from "../../prompts/v1/index.ts";
import type { TelemetryReactInput } from "../../prompts/v1/index.ts";
import { clip, llmInfoOf } from "../../app/trace-sink.ts";
import type { TraceSink } from "../../app/trace-sink.ts";
import { CATEGORY_LABELS, CONFIDENCE_LABELS } from "../../domain/report/postmortem-template.ts";
import { lastBriefFor, runContextOf } from "../run-context.ts";
import type { NodeFn } from "../run-context.ts";

const TOOL_TICK_SEC = 3;
const DEFAULT_BRIEF = "Investigate the alert and return a diagnosis with evidence.";

const SOURCE_BY_TOOL: Record<ReadToolName, Evidence["source"]> = {
  query_metrics: "metrics",
  query_logs: "logs",
  list_deploys: "deploys",
  audit_cloud_inventory: "inventory",
};

export type TelemetryDeps = { llm: LlmProvider; tools: ToolRegistry; scenarios: ScenarioRepository; trace: TraceSink; clock: Clock; limits: Limits };

function diagnosisHeadline(d: Pick<Diagnosis, "category" | "confidence" | "evidence">): string {
  return `diagnosis ${d.category} (${CATEGORY_LABELS[d.category]}, ${CONFIDENCE_LABELS[d.confidence]} confidence, ${d.evidence.length} ${d.evidence.length === 1 ? "piece" : "pieces"} of evidence)`;
}

export function createTelemetryNode(d: TelemetryDeps): NodeFn {
  return async (state, config) => {
    const ctx = runContextOf(state, config);
    const scenario = d.scenarios.get(state.scenarioId, { offsetSec: state.timeOffsetSec });
    const run = state.telemetryRuns + 1;
    const brief = lastBriefFor(state, "telemetry_analyst") || DEFAULT_BRIEF;
    const maxSteps = d.limits.reactMaxSteps;
    const history: TelemetryReactInput["history"] = [];
    const okObservations: { tool: ReadToolName; summary: string; evidenceRef: string | null }[] = [];

    const finish = (diagnosis: Diagnosis, reason: string) => {
      d.trace.emit(ctx, "telemetry_analyst", { type: "answer", payload: { kind: "diagnosis", text: `${diagnosisHeadline(diagnosis)}: ${diagnosis.hypothesis}` } });
      d.trace.emit(ctx, "telemetry_analyst", { type: "handoff", payload: { from: "telemetry_analyst", to: "supervisor", brief: diagnosisHeadline(diagnosis), reason } });
      return { diagnosis, telemetryRuns: run, phase: "investigating" as const };
    };

    for (let step = 1; step <= maxSteps; step++) {
      const input: TelemetryReactInput = { alert: state.alert, brief, run, step, maxSteps, toolsDescription: d.tools.describeForPrompt(), history: [...history] };
      const r = await d.llm.generate(telemetryReactPrompt, input, ctx);
      if (!r.success) {
        return { escalation: { reason: "llm_unavailable" as const, detail: clip(`telemetry analyst, step ${step}: ${r.error.kind} (${r.error.message})`, 400) } };
      }
      const out = r.data;
      d.trace.emit(ctx, "telemetry_analyst", { type: "thought", payload: { text: out.thought } }, llmInfoOf(telemetryReactPrompt, r));
      if (out.kind === "final") {
        return finish({ ...out.diagnosis, capReached: false }, `round ${run} completed in ${step} step${step === 1 ? "" : "s"}`);
      }
      d.trace.emit(ctx, "telemetry_analyst", { type: "action", payload: { tool: out.tool, args: out.args, tier: 1 } });
      const res = d.tools.run(out.tool, out.args, { scenario, world: state.world, now: d.clock.now() });
      d.clock.tick(TOOL_TICK_SEC);
      d.trace.emit(ctx, "telemetry_analyst", { type: "observation", payload: { tool: out.tool, ok: res.ok, summary: res.summary, evidenceRef: res.evidenceRef } });
      history.push({ thought: out.thought, tool: out.tool, args: out.args, ok: res.ok, observation: res.summary });
      if (res.ok && out.tool in SOURCE_BY_TOOL) okObservations.push({ tool: out.tool as ReadToolName, summary: res.summary, evidenceRef: res.evidenceRef });
    }

    // Teto atingido sem resposta final: diagnóstico fraco com o que as observações válidas mostraram.
    const evidence: Evidence[] = okObservations.slice(0, 8).map((o) => ({
      source: SOURCE_BY_TOOL[o.tool],
      ref: o.evidenceRef ?? `${SOURCE_BY_TOOL[o.tool]}:${o.tool}`,
      summary: clip(o.summary, 300),
    }));
    if (evidence.length === 0) {
      const scope = state.alert.service ?? state.alert.account ?? "desconhecido";
      evidence.push({ source: "metrics", ref: `metrics:${scope}:${state.alert.signal}@alerta`, summary: clip(`alerta: ${state.alert.rule}`, 300) });
    }
    const diagnosis: Diagnosis = {
      hypothesis: `Investigation stopped at the cap of ${maxSteps} steps without a conclusion`,
      category: "unknown",
      confidence: "low",
      evidence,
      capReached: true,
    };
    return finish(diagnosis, `cap of ${maxSteps} steps reached in round ${run}`);
  };
}
