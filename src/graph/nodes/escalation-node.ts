// Escalation (spec 4.5 and 6.3): route decided by code only. Writes the "system" agent's response and the
// incident_escalated audit; the report comes after, always from the template. Receives no LLM.
// With no reason in the state, the only route that reaches here is the gate with nothing executable (no_executable_actions).
import type { AuditEntry, Escalation } from "../../contracts/index.ts";
import type { NewAuditEntry } from "../../infra/db/incident-store.ts";
import { escalationSentence } from "../../domain/report/postmortem-template.ts";
import type { TraceSink } from "../../app/trace-sink.ts";
import { runContextOf } from "../run-context.ts";
import type { NodeFn } from "../run-context.ts";

const NOTHING_TO_RUN: Escalation = { reason: "no_executable_actions", detail: "the gate left no action ready or pending approval" };

export function createEscalationNode(d: { trace: TraceSink; audit: (e: NewAuditEntry) => AuditEntry }): NodeFn {
  return async (state, config) => {
    const ctx = runContextOf(state, config);
    const escalation = state.escalation ?? NOTHING_TO_RUN;
    d.trace.emit(ctx, "system", {
      type: "answer",
      payload: { kind: "escalation", text: escalationSentence(escalation) },
    });
    d.audit({
      incidentId: state.incidentId,
      actor: "system:escalation",
      event: "incident_escalated",
      tier: null,
      details: { reason: escalation.reason, detail: escalation.detail, requestId: ctx.requestId },
    });
    return state.escalation ? { phase: "reporting" } : { escalation, phase: "reporting" };
  };
}
