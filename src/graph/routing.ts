// Graph routes decided by code (spec 4.5 and 4.5.1). Pure functions over the blackboard: no route to
// escalation comes from the LLM; any node that sets `escalation` diverts to the escalation node on the next edge.
import type { Blackboard, Limits } from "../contracts/index.ts";
import { supervisorTargetOf } from "./nodes/supervisor-node.ts";

/** Logical node names (the graph's AgentIds), used by the route functions and by GraphNodes. */
export const NODE_NAMES = [
  "supervisor", "telemetry_analyst", "runbook_retriever", "remediation_planner", "auditor",
  "gate", "executor", "verifier", "reporter", "escalation",
] as const;
export type NodeName = (typeof NODE_NAMES)[number];

/**
 * Node id registered in LangGraph. The library refuses a node with the same name as a state key
 * ("supervisor is already being used as a state attribute"), and `supervisor` and `escalation` are blackboard keys.
 * Routes return the logical name; each edge's pathMap translates it to the id.
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

/** Value of END in LangGraph; the gate route returns it when there is a pending approval. */
export const END_ROUTE = "__end__";

/** START: the first invocation enters via the supervisor; the resume after decisions enters via the executor. */
export function entryRoute(bb: Blackboard): "supervisor" | "executor" {
  return bb.phase === "resume" ? "executor" : "supervisor";
}

/** Escalation set by the supervisor itself (caps or LLM unavailable) wins; otherwise, the target validated by the guard. */
export function afterSupervisor(bb: Blackboard): NodeName {
  if (bb.escalation !== null) return "escalation";
  const target = supervisorTargetOf(bb);
  if (target === null) throw new Error("supervisor finished with neither a decision nor an escalation (routing defect)");
  return target;
}

/** telemetry_analyst and runbook_retriever return to the supervisor, unless escalated (LLM unavailable). */
export function afterSpecialist(bb: Blackboard): "supervisor" | "escalation" {
  return bb.escalation !== null ? "escalation" : "supervisor";
}

export function afterPlanner(bb: Blackboard): "auditor" | "escalation" {
  return bb.escalation !== null ? "escalation" : "auditor";
}

/** Reflection: goes back to the planner while the final verdict is revise and revisions remain. */
export function afterAuditor(bb: Blackboard, limits: Limits): "remediation_planner" | "supervisor" {
  return bb.audit?.verdict === "revise" && bb.planRevision < limits.maxPlanRevisions ? "remediation_planner" : "supervisor";
}

/**
 * Shadow mode (live incidents, spec 008) goes straight to the reporter: nothing executes. Otherwise a pending approval
 * ends the invocation; a ready action goes to the executor; nothing executable escalates.
 */
export function afterGate(bb: Blackboard, pendingApprovals: number): "executor" | "escalation" | "reporter" | typeof END_ROUTE {
  if (bb.origin?.mode === "shadow") return "reporter";
  if (pendingApprovals > 0) return END_ROUTE;
  if (bb.actions.some((a) => a.status === "ready")) return "executor";
  return "escalation";
}

/** The verifier only runs if some mitigating action finished succeeded (spec 6.5); the escalation reason belongs to the executor. */
export function afterExecutor(bb: Blackboard, isMitigating: (actionType: string) => boolean): "verifier" | "escalation" {
  if (bb.escalation === null && bb.actions.some((a) => a.status === "succeeded" && isMitigating(a.actionType))) return "verifier";
  return "escalation";
}

/** A healthy canary returns to the supervisor (which picks the reporter); a failed one escalates with remediation_ineffective. */
export function afterVerifier(bb: Blackboard): "supervisor" | "escalation" {
  return bb.escalation === null && bb.verification?.healthy === true ? "supervisor" : "escalation";
}
