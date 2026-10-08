// Rotas do grafo decididas por código (spec 4.5 e 4.5.1). Funções puras sobre o blackboard: nenhuma rota para
// escalonamento vem do LLM; qualquer nó que defina `escalation` desvia para o nó escalation na aresta seguinte.
import type { Blackboard, Limits } from "../contracts/index.ts";
import { supervisorTargetOf } from "./nodes/supervisor-node.ts";

/** Nomes lógicos dos nós (os AgentId do grafo), usados pelas funções de rota e por GraphNodes. */
export const NODE_NAMES = [
  "supervisor", "telemetry_analyst", "runbook_retriever", "remediation_planner", "auditor",
  "gate", "executor", "verifier", "reporter", "escalation",
] as const;
export type NodeName = (typeof NODE_NAMES)[number];

/**
 * Id do nó registrado no LangGraph. A biblioteca recusa um nó com o mesmo nome de uma chave do estado
 * ("supervisor is already being used as a state attribute"), e `supervisor` e `escalation` são chaves do blackboard.
 * As rotas devolvem o nome lógico; o pathMap de cada aresta traduz para o id.
 */
export const GRAPH_NODE_ID: Record<NodeName, string> = {
  supervisor: "supervisor_agent",
  telemetry_analyst: "telemetry_analyst",
  runbook_retriever: "runbook_retriever",
  remediation_planner: "remediation_planner",
  auditor: "auditor",
  gate: "gate",
  executor: "executor",
  verifier: "verifier",
  reporter: "reporter",
  escalation: "escalation_node",
};

/** Valor de END no LangGraph; a rota do portão o devolve quando há aprovação pendente. */
export const END_ROUTE = "__end__";

/** START: a primeira invocação entra pelo supervisor; a retomada depois das decisões entra pelo executor. */
export function entryRoute(bb: Blackboard): "supervisor" | "executor" {
  return bb.phase === "resume" ? "executor" : "supervisor";
}

/** Escalonamento definido pelo próprio supervisor (tetos ou LLM indisponível) vence; senão, o alvo validado pela guarda. */
export function afterSupervisor(bb: Blackboard): NodeName {
  if (bb.escalation !== null) return "escalation";
  const target = supervisorTargetOf(bb);
  if (target === null) throw new Error("supervisor finished with neither a decision nor an escalation (routing defect)");
  return target;
}

/** telemetry_analyst e runbook_retriever voltam ao supervisor, salvo escalonamento (LLM indisponível). */
export function afterSpecialist(bb: Blackboard): "supervisor" | "escalation" {
  return bb.escalation !== null ? "escalation" : "supervisor";
}

export function afterPlanner(bb: Blackboard): "auditor" | "escalation" {
  return bb.escalation !== null ? "escalation" : "auditor";
}

/** Reflection: volta ao planejador enquanto o veredito final for revise e houver revisões sobrando. */
export function afterAuditor(bb: Blackboard, limits: Limits): "remediation_planner" | "supervisor" {
  return bb.audit?.verdict === "revise" && bb.planRevision < limits.maxPlanRevisions ? "remediation_planner" : "supervisor";
}

/** Pendência de aprovação encerra a invocação; ação pronta vai ao executor; nada executável escala. */
export function afterGate(bb: Blackboard, pendingApprovals: number): "executor" | "escalation" | typeof END_ROUTE {
  if (pendingApprovals > 0) return END_ROUTE;
  if (bb.actions.some((a) => a.status === "ready")) return "executor";
  return "escalation";
}

/** O verificador só roda se alguma ação mitigadora terminou succeeded (spec 6.5); o motivo do escalonamento é do executor. */
export function afterExecutor(bb: Blackboard, isMitigating: (actionType: string) => boolean): "verifier" | "escalation" {
  if (bb.escalation === null && bb.actions.some((a) => a.status === "succeeded" && isMitigating(a.actionType))) return "verifier";
  return "escalation";
}

/** Canário saudável volta ao supervisor (que escolhe o relator); reprovado escala com remediation_ineffective. */
export function afterVerifier(bb: Blackboard): "supervisor" | "escalation" {
  return bb.escalation === null && bb.verification?.healthy === true ? "supervisor" : "escalation";
}
