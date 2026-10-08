// Contexto de execução dos nós: o grafo passa `signal` e `configurable.requestId` no segundo argumento do nó.
import type { AgentId, Blackboard } from "../contracts/index.ts";
import type { RunContext } from "../llm/provider.ts";

export type NodeConfig = { signal?: AbortSignal; configurable?: { requestId?: string | null } };
export type NodeFn = (state: Blackboard, config?: NodeConfig) => Promise<Partial<Blackboard>>;

export function runContextOf(state: Blackboard, config?: NodeConfig): RunContext {
  return {
    incidentId: state.incidentId,
    runId: state.runId,
    scenarioId: state.scenarioId,
    requestId: config?.configurable?.requestId ?? null,
    signal: config?.signal ?? new AbortController().signal,
  };
}

/** Brief da última entrada do histórico do supervisor dirigida a `agent`; "" se não houver. */
export function lastBriefFor(state: Blackboard, agent: AgentId): string {
  for (let i = state.supervisor.history.length - 1; i >= 0; i--) {
    const h = state.supervisor.history[i]!;
    if (h.to === agent) return h.brief;
  }
  return "";
}
