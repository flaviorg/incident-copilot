// Remediation planner (spec 4.6 and 5.1, step 6): no tools; sees the catalog as text and the auditor's feedback.
// The output is validated by RemediationPlanSchema at the provider edge (at most 8 steps).
import type { LlmProvider } from "../../llm/provider.ts";
import { plannerPrompt } from "../../prompts/v1/index.ts";
import { clip, llmInfoOf } from "../../app/trace-sink.ts";
import type { TraceSink } from "../../app/trace-sink.ts";
import { runContextOf } from "../run-context.ts";
import type { NodeFn } from "../run-context.ts";

export function createPlannerNode(d: { llm: LlmProvider; trace: TraceSink; catalogText: () => string }): NodeFn {
  return async (state, config) => {
    const ctx = runContextOf(state, config);
    if (state.diagnosis === null) throw new Error("planner invoked without a diagnosis (the supervisor guard should prevent this)");
    const revision = state.plan ? state.planRevision + 1 : 0;
    const auditorFeedback = state.audit?.verdict === "revise" ? state.audit.feedback : null;
    const r = await d.llm.generate(
      plannerPrompt,
      {
        alert: state.alert,
        ...(state.origin ? { externalAlert: true } : {}),
        diagnosis: state.diagnosis,
        runbookExcerpts: state.runbookMatches.map((m) => ({ ref: `${m.runbookId}#${m.section}`, excerpt: m.excerpt })),
        catalogText: d.catalogText(),
        revision,
        auditorFeedback,
      },
      ctx,
    );
    if (!r.success) {
      return { escalation: { reason: "llm_unavailable" as const, detail: clip(`planner, revision ${revision}: ${r.error.kind} (${r.error.message})`, 400) } };
    }
    const plan = r.data;
    d.trace.emit(ctx, "remediation_planner", { type: "plan", payload: { revision, summary: plan.summary, steps: plan.steps } }, llmInfoOf(plannerPrompt, r));
    d.trace.emit(ctx, "remediation_planner", {
      type: "handoff",
      payload: {
        from: "remediation_planner",
        to: "auditor",
        brief: `plan revision ${revision} with ${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}`,
        reason: revision === 0 ? "initial plan for audit" : "revision requested by the auditor",
      },
    });
    return { plan, planRevision: revision, audit: null, phase: "planning" };
  };
}
