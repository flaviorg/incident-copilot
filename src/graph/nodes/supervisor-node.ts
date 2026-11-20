// Supervisor (spec 4.6 and 6.3; lesson 221528): only orchestrates. Checks the caps before the LLM, validates the choice with the guard
// and records each decision as a handoff in the trace and in the blackboard history.
import type { Blackboard, HandoffRecord, Limits, Phase } from "../../contracts/index.ts";
import type { LlmProvider } from "../../llm/provider.ts";
import { supervisorPrompt } from "../../prompts/v1/index.ts";
import type { SupervisorInput } from "../../prompts/v1/index.ts";
import { guardChoice, preEscalation } from "../../domain/supervisor/supervisor-guard.ts";
import type { SupervisorTarget } from "../../domain/supervisor/supervisor-guard.ts";
import { CATEGORY_LABELS, CONFIDENCE_LABELS } from "../../domain/report/postmortem-template.ts";
import { clip, llmInfoOf } from "../../app/trace-sink.ts";
import type { TraceSink } from "../../app/trace-sink.ts";
import { runContextOf } from "../run-context.ts";
import type { NodeFn } from "../run-context.ts";

const SUPERVISOR_TARGETS: readonly string[] = ["telemetry_analyst", "runbook_retriever", "remediation_planner", "gate", "reporter"];

/** "to" of the last supervisor history entry (used by routing right after the node). */
export function supervisorTargetOf(bb: Blackboard): SupervisorTarget | null {
  const to = bb.supervisor.history.at(-1)?.to;
  return to !== undefined && SUPERVISOR_TARGETS.includes(to) ? (to as SupervisorTarget) : null;
}

function inputOf(bb: Blackboard): SupervisorInput {
  const d = bb.diagnosis;
  return {
    alert: bb.alert,
    ...(bb.origin ? { externalAlert: true } : {}),
    flags: {
      hasDiagnosis: d !== null,
      runbookSearchDone: bb.runbookSearchDone,
      hasPlan: bb.plan !== null,
      hasAudit: bb.audit !== null,
      verified: bb.verification?.healthy === true,
    },
    diagnosisSummary: d ? `${d.category} (${CATEGORY_LABELS[d.category]}), ${CONFIDENCE_LABELS[d.confidence]} confidence: ${d.hypothesis}` : null,
    lastHandoffs: bb.supervisor.history.slice(-3).map((h) => ({ from: h.from, to: h.to, brief: h.brief })),
  };
}

function phaseFor(next: SupervisorTarget, bb: Blackboard): Phase {
  if (next === "gate") return "gating";
  if (next === "reporter") return "reporting";
  return bb.diagnosis !== null && bb.runbookSearchDone ? "planning" : "investigating";
}

export function createSupervisorNode(d: { llm: LlmProvider; trace: TraceSink; limits: Limits }): NodeFn {
  return async (state, config) => {
    const ctx = runContextOf(state, config);
    const iterations = state.supervisor.iterations + 1;
    const counted: Blackboard = { ...state, supervisor: { iterations, history: state.supervisor.history } };

    const pre = preEscalation(counted, d.limits);
    if (pre) return { supervisor: counted.supervisor, escalation: { reason: pre.reason, detail: clip(pre.detail, 400) } };

    const r = await d.llm.generate(supervisorPrompt, inputOf(counted), ctx);
    if (!r.success) {
      return { supervisor: counted.supervisor, escalation: { reason: "llm_unavailable" as const, detail: clip(`supervisor: ${r.error.kind} (${r.error.message})`, 400) } };
    }

    const g = guardChoice(r.data.next, counted, d.limits);
    if (g.coerced) {
      d.trace.emit(ctx, "supervisor", {
        type: "critique",
        payload: { by: "supervisor_guard", verdict: "coerced", feedback: `choice ${r.data.next} refused: ${g.reason}; following ${g.next}` },
      });
    }
    d.trace.emit(ctx, "supervisor", { type: "handoff", payload: { from: "supervisor", to: g.next, brief: r.data.brief, reason: r.data.reason } }, llmInfoOf(supervisorPrompt, r));
    const record: HandoffRecord = { iteration: iterations, from: "supervisor", to: g.next, brief: r.data.brief, reason: r.data.reason, coerced: g.coerced };
    return { supervisor: { iterations, history: [...state.supervisor.history, record] }, phase: phaseFor(g.next, counted) };
  };
}
