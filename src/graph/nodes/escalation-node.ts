// Escalonamento (spec 4.5 e 6.3): rota decidida só por código. Grava a resposta do agente "system" e a auditoria
// incident_escalated; o relatório vem depois, sempre pelo template. Não recebe LLM.
// Sem motivo no estado, a única rota que chega aqui é o portão sem nada executável (no_executable_actions).
import type { AuditEntry, Escalation } from "../../contracts/index.ts";
import type { NewAuditEntry } from "../../infra/db/incident-store.ts";
import { escalationSentence } from "../../domain/report/postmortem-template.ts";
import type { TraceSink } from "../../app/trace-sink.ts";
import { runContextOf } from "../run-context.ts";
import type { NodeFn } from "../run-context.ts";

const NOTHING_TO_RUN: Escalation = { reason: "no_executable_actions", detail: "o portão não deixou nenhuma ação pronta nem pendente de aprovação" };

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
