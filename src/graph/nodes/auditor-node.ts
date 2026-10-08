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
    if (state.plan === null || state.diagnosis === null) throw new Error("auditor acionado sem plano ou sem diagnóstico");
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
    let feedback = r.success ? r.data.feedback : `modelo indisponível (${r.error.kind}); veredito pelas regras`;
    if (failed.length > 0) feedback += ` | regras falhas: ${failed.join(", ")}`;
    if (overridden) feedback += " | veredito do modelo sobrescrito pelas regras";
    feedback = clip(feedback, 600);

    d.trace.emit(ctx, "auditor", { type: "critique", payload: { by: "auditor", verdict, feedback, overridden } }, llmInfoOf(auditorPrompt, r));
    const backToPlanner = verdict === "revise" && state.planRevision < d.limits.maxPlanRevisions;
    const passed = checks.filter((c) => c.passed).length;
    d.trace.emit(ctx, "auditor", {
      type: "handoff",
      payload: {
        from: "auditor",
        to: backToPlanner ? "remediation_planner" : "supervisor",
        brief: backToPlanner ? clip(`revise o plano: ${feedback}`, 400) : `plano revisão ${state.planRevision} ${verdict === "approve" ? "aprovado" : "com revisões esgotadas"} (${passed} de ${checks.length} regras ok)`,
        reason: overridden ? "regras em código reprovaram o plano apesar do modelo" : `veredito ${verdict === "approve" ? "aprovado" : "revisar"}`,
      },
    });
    return { audit: { verdict, feedback, checks, llmVerdict, overridden }, phase: "planning" };
  };
}
