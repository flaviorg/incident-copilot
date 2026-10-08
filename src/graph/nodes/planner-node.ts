// Planejador de remediação (spec 4.6 e 5.1, passo 6): sem ferramentas; vê o catálogo como texto e o feedback do auditor.
// A saída é validada pelo RemediationPlanSchema na borda do provedor (no máximo 8 passos).
import type { LlmProvider } from "../../llm/provider.ts";
import { plannerPrompt } from "../../prompts/v1/index.ts";
import { clip, llmInfoOf } from "../../app/trace-sink.ts";
import type { TraceSink } from "../../app/trace-sink.ts";
import { runContextOf } from "../run-context.ts";
import type { NodeFn } from "../run-context.ts";

export function createPlannerNode(d: { llm: LlmProvider; trace: TraceSink; catalogText: () => string }): NodeFn {
  return async (state, config) => {
    const ctx = runContextOf(state, config);
    if (state.diagnosis === null) throw new Error("planejador acionado sem diagnóstico (a guarda do supervisor deveria impedir)");
    const revision = state.plan ? state.planRevision + 1 : 0;
    const auditorFeedback = state.audit?.verdict === "revise" ? state.audit.feedback : null;
    const r = await d.llm.generate(
      plannerPrompt,
      {
        alert: state.alert,
        diagnosis: state.diagnosis,
        runbookExcerpts: state.runbookMatches.map((m) => ({ ref: `${m.runbookId}#${m.section}`, excerpt: m.excerpt })),
        catalogText: d.catalogText(),
        revision,
        auditorFeedback,
      },
      ctx,
    );
    if (!r.success) {
      return { escalation: { reason: "llm_unavailable" as const, detail: clip(`planejador, revisão ${revision}: ${r.error.kind} (${r.error.message})`, 400) } };
    }
    const plan = r.data;
    d.trace.emit(ctx, "remediation_planner", { type: "plan", payload: { revision, summary: plan.summary, steps: plan.steps } }, llmInfoOf(plannerPrompt, r));
    d.trace.emit(ctx, "remediation_planner", {
      type: "handoff",
      payload: {
        from: "remediation_planner",
        to: "auditor",
        brief: `plano revisão ${revision} com ${plan.steps.length} passo${plan.steps.length === 1 ? "" : "s"}`,
        reason: revision === 0 ? "plano inicial para auditoria" : "revisão pedida pelo auditor",
      },
    });
    return { plan, planRevision: revision, audit: null, phase: "planning" };
  };
}
