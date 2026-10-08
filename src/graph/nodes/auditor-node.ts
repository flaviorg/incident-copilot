// Auditor de plano (spec 4.7; Reflection da 221513 com piso em código): regras determinísticas primeiro, depois auditor.v1.
// O LLM pode endurecer o veredito, nunca afrouxar; LLM indisponível não escala, valem as regras.
import type { Limits } from "../../contracts/index.ts";
import type { ScenarioRepository } from "../../infra/scenarios/scenario-loader.ts";
import type { LlmProvider } from "../../llm/provider.ts";
import { auditorPrompt } from "../../prompts/v1/index.ts";
import { combineAuditorVerdict, runAuditorRules } from "../../domain/audit/auditor-rules.ts";
import { impactStartOf } from "../../domain/metrics/incident-metrics.ts";
import { clip, llmInfoOf } from "../../app/trace-sink.ts";
import type { TraceSink } from "../../app/trace-sink.ts";
import { runContextOf } from "../run-context.ts";
import type { NodeFn } from "../run-context.ts";

/** `limits` só decide para quem vai o handoff, para o trace dizer o mesmo que a aresta afterAuditor. */
export function createAuditorNode(d: { llm: LlmProvider; trace: TraceSink; scenarios: ScenarioRepository; limits: Limits }): NodeFn {
  return async (state, config) => {
    const ctx = runContextOf(state, config);
    if (state.plan === null || state.diagnosis === null) throw new Error("auditor invoked without a plan or a diagnosis");
    const scenario = d.scenarios.get(state.scenarioId, { offsetSec: state.timeOffsetSec });
    const checks = runAuditorRules(state.plan, {
      inventory: state.world.inventory ?? scenario.inventory,
      deploys: scenario.deploys,
      impactStartedAt: impactStartOf(scenario.alert, scenario.series),
    });
    const r = await d.llm.generate(auditorPrompt, { diagnosis: state.diagnosis, plan: state.plan, checks, revision: state.planRevision }, ctx);
    const llmVerdict = r.success ? r.data.verdict : null;
    const { verdict, overridden } = combineAuditorVerdict(checks, llmVerdict);
    const failed = checks.filter((c) => !c.passed).map((c) => c.rule);
    let feedback = r.success ? r.data.feedback : `model unavailable (${r.error.kind}); verdict by the rules`;
    if (failed.length > 0) feedback += ` | failed rules: ${failed.join(", ")}`;
    if (overridden) feedback += " | model verdict overridden by the rules";
    feedback = clip(feedback, 600);

    d.trace.emit(ctx, "auditor", { type: "critique", payload: { by: "auditor", verdict, feedback, overridden } }, llmInfoOf(auditorPrompt, r));
    const backToPlanner = verdict === "revise" && state.planRevision < d.limits.maxPlanRevisions;
    const passed = checks.filter((c) => c.passed).length;
    d.trace.emit(ctx, "auditor", {
      type: "handoff",
      payload: {
        from: "auditor",
        to: backToPlanner ? "remediation_planner" : "supervisor",
        brief: backToPlanner ? clip(`revise the plan: ${feedback}`, 400) : `plan revision ${state.planRevision} ${verdict === "approve" ? "approved" : "with revisions exhausted"} (${passed} of ${checks.length} rules ok)`,
        reason: overridden ? "rules in code rejected the plan despite the model" : `verdict ${verdict === "approve" ? "approved" : "revise"}`,
      },
    });
    return { audit: { verdict, feedback, checks, llmVerdict, overridden }, phase: "planning" };
  };
}
