// Guarda do supervisor (spec 6.3): o LLM escolhe, o código valida as pré-condições. Puro.
// Escolha inválida vira critique e segue a rota canônica: o primeiro artefato faltante na ordem
// diagnóstico, runbooks, plano auditado, portão, relatório.
import type { Blackboard, EscalationReason, Limits, SupervisorDecision } from "../../contracts/index.ts";

export type SupervisorTarget = "telemetry_analyst" | "runbook_retriever" | "remediation_planner" | "gate" | "reporter";

const confident = (bb: Blackboard) => bb.diagnosis !== null && (bb.diagnosis.confidence === "medium" || bb.diagnosis.confidence === "high");

/** Sem diagnóstico, ou diagnóstico fraco sem teto do ReAct e com rodadas sobrando. */
const needsTelemetry = (bb: Blackboard, limits: Limits) =>
  bb.diagnosis === null || (bb.diagnosis.confidence === "low" && !bb.diagnosis.capReached && bb.telemetryRuns < limits.maxTelemetryRuns);

/**
 * Chamado com `supervisor.iterations` já incrementado, antes do LLM. Ordem do spec 6.3:
 * teto de equipe, teto do ReAct, diagnóstico fraco depois das rodadas permitidas.
 */
export function preEscalation(bb: Blackboard, limits: Limits): { reason: EscalationReason; detail: string } | null {
  if (bb.supervisor.iterations > limits.teamMaxIterations) {
    return { reason: "team_cap_reached", detail: `supervisor acionado ${bb.supervisor.iterations} vezes; o teto da equipe é ${limits.teamMaxIterations}` };
  }
  if (bb.diagnosis?.capReached) {
    return { reason: "react_cap_low_confidence", detail: `o analista atingiu o teto de ${limits.reactMaxSteps} passos sem conclusão` };
  }
  if (bb.diagnosis?.confidence === "low" && bb.telemetryRuns >= limits.maxTelemetryRuns) {
    return { reason: "low_confidence_diagnosis", detail: `diagnóstico ainda com confiança baixa depois de ${bb.telemetryRuns} rodadas do analista` };
  }
  return null;
}

/** Motivo da recusa, ou null se a pré-condição vale (tabela do spec 6.3). */
function violation(target: SupervisorTarget, bb: Blackboard, limits: Limits): string | null {
  switch (target) {
    case "telemetry_analyst":
      if (needsTelemetry(bb, limits)) return null;
      if (bb.diagnosis?.capReached) return "o analista já atingiu o teto de passos";
      if (bb.diagnosis?.confidence === "low") return `o analista já rodou ${bb.telemetryRuns} vezes, o máximo permitido`;
      return "já existe diagnóstico com confiança média ou alta";
    case "runbook_retriever":
      if (!confident(bb)) return "falta diagnóstico com confiança média ou alta";
      if (bb.runbookSearchDone) return "a busca de runbooks já foi feita e não se repete";
      return null;
    case "remediation_planner":
      if (!confident(bb)) return "falta diagnóstico com confiança média ou alta";
      if (!bb.runbookSearchDone) return "a busca de runbooks ainda não foi feita";
      if (bb.plan !== null) return "já existe plano";
      return null;
    case "gate":
      if (bb.plan === null) return "não há plano";
      if (bb.audit === null) return "o plano ainda não foi auditado";
      if (bb.actions.length > 0) return "o portão já processou este plano";
      return null;
    case "reporter":
      if (bb.verification?.healthy === true || bb.escalation !== null) return null;
      return "a recuperação ainda não foi verificada";
  }
}

export function canonicalNext(bb: Blackboard, limits: Limits): SupervisorTarget {
  if (needsTelemetry(bb, limits)) return "telemetry_analyst";
  if (!bb.runbookSearchDone) return "runbook_retriever";
  if (bb.plan === null || bb.audit === null) return "remediation_planner";
  if (bb.actions.length === 0) return "gate";
  return "reporter";
}

/** `done` vira `reporter` e é validado como tal. */
export function guardChoice(choice: SupervisorDecision["next"], bb: Blackboard, limits: Limits): { next: SupervisorTarget; coerced: boolean; reason: string } {
  const target: SupervisorTarget = choice === "done" ? "reporter" : choice;
  const why = violation(target, bb, limits);
  if (why === null) return { next: target, coerced: false, reason: "" };
  return { next: canonicalNext(bb, limits), coerced: true, reason: why };
}
