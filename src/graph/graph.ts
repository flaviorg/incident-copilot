// Grafo da equipe (spec 4.5): supervisor com especialistas, Reflection do auditor, portão, execução, verificação,
// escalonamento e relatório. Um addConditionalEdges por origem, com pathMap explícito do nome lógico para o id do nó.
import { StateGraph, START, END } from "@langchain/langgraph";
import type { Blackboard, Limits } from "../contracts/index.ts";
import { IncidentGraphState } from "./state.ts";
import {
  afterAuditor, afterExecutor, afterGate, afterPlanner, afterSpecialist, afterSupervisor, afterVerifier, END_ROUTE, entryRoute,
  GRAPH_NODE_ID, NODE_NAMES,
} from "./routing.ts";
import type { NodeName } from "./routing.ts";
import type { NodeFn } from "./run-context.ts";

export type GraphNodes = Record<NodeName, NodeFn>;

export type IncidentStreamOptions = {
  streamMode: "values";
  recursionLimit: number;
  signal: AbortSignal;
  configurable: { requestId: string | null };
};

/** O que o IncidentService usa do grafo compilado: o stream de estados completos (um por superstep). */
export interface CompiledIncidentGraph {
  stream(input: Blackboard, o: IncidentStreamOptions): Promise<AsyncIterable<Blackboard>>;
}

export type GraphDeps = {
  limits: Limits;
  /** Aprovações do incidente com status efetivo pending (lidas do store no momento da rota). */
  pendingApprovals: (incidentId: string) => number;
  isMitigating: (actionType: string) => boolean;
};

/** pathMap de uma aresta: cada destino lógico possível para o id do nó (END fica como está). */
function pathMap<T extends NodeName | typeof END_ROUTE>(targets: readonly T[]): Record<string, string> {
  return Object.fromEntries(targets.map((t) => [t, t === END_ROUTE ? END : GRAPH_NODE_ID[t as NodeName]]));
}

export function buildIncidentGraph(nodes: GraphNodes, d: GraphDeps): CompiledIncidentGraph {
  const id = GRAPH_NODE_ID;
  const g = new StateGraph(IncidentGraphState);
  for (const name of NODE_NAMES) g.addNode(id[name], nodes[name]);
  const graph = g as unknown as StateGraph<typeof IncidentGraphState, Blackboard, Partial<Blackboard>, string>;

  graph.addConditionalEdges(START, (s: Blackboard) => entryRoute(s), pathMap(["supervisor", "executor"]));
  graph.addConditionalEdges(id.supervisor, (s: Blackboard) => afterSupervisor(s),
    pathMap(["telemetry_analyst", "runbook_retriever", "remediation_planner", "gate", "reporter", "escalation"]));
  graph.addConditionalEdges(id.telemetry_analyst, (s: Blackboard) => afterSpecialist(s), pathMap(["supervisor", "escalation"]));
  graph.addConditionalEdges(id.runbook_retriever, (s: Blackboard) => afterSpecialist(s), pathMap(["supervisor", "escalation"]));
  graph.addConditionalEdges(id.remediation_planner, (s: Blackboard) => afterPlanner(s), pathMap(["auditor", "escalation"]));
  graph.addConditionalEdges(id.auditor, (s: Blackboard) => afterAuditor(s, d.limits), pathMap(["remediation_planner", "supervisor"]));
  graph.addConditionalEdges(id.gate, (s: Blackboard) => afterGate(s, d.pendingApprovals(s.incidentId)), pathMap(["executor", "escalation", END_ROUTE]));
  graph.addConditionalEdges(id.executor, (s: Blackboard) => afterExecutor(s, d.isMitigating), pathMap(["verifier", "escalation"]));
  graph.addConditionalEdges(id.verifier, (s: Blackboard) => afterVerifier(s), pathMap(["supervisor", "escalation"]));
  graph.addEdge(id.escalation, id.reporter);
  graph.addEdge(id.reporter, END);

  const compiled = graph.compile();
  return {
    async stream(input, o) {
      return (await compiled.stream(input, o)) as unknown as AsyncIterable<Blackboard>;
    },
  };
}
