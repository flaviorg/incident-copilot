// Run context for the nodes: the graph passes `signal` and `configurable.requestId` in the node's second argument.
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

/** Brief of the last supervisor history entry directed at `agent`; "" if none. */
export function lastBriefFor(state: Blackboard, agent: AgentId): string {
  for (let i = state.supervisor.history.length - 1; i >= 0; i--) {
    const h = state.supervisor.history[i]!;
    if (h.to === agent) return h.brief;
  }
  return "";
}
