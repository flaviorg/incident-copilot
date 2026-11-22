// Code fixer graph (spec 009, decision 2): its own small StateGraph over CodeFixStateSchema, one node per factory, the
// pure routes of routing.ts, one addConditionalEdges per origin with an explicit pathMap, no checkpointer and no
// interrupt. The caller passes `recursionLimit` (CODE_FIX_RECURSION_LIMIT) and the attempt's signal.
//
// The signal reaches the nodes, never LangGraph: LangGraph rejects the whole run with an AbortError when its own signal
// fires, which would skip fix_give_up. Each node reads it as `config.signal`, returns `attempt_timeout` and the attempt
// ends through fix_give_up without throwing (decision 17, AC-81).
import { StateGraph, START, END } from "@langchain/langgraph";
import { CODE_FIX_CEILINGS } from "../../domain/code-fix/limits.ts";
import type { NodeConfig } from "../run-context.ts";
import {
  afterAuthorPatch, afterAuthorTest, afterBaseline, afterEligibility, afterFinalize, afterGuardPatch, afterGuardTest, afterLocate,
  afterRepro, afterReview, afterVerify, afterWorkspace, FIX_EDGE_TARGETS, FIX_END, FIX_NODE_IDS,
} from "./routing.ts";
import type { FixNodeId, FixRoute, FixRouteLimits } from "./routing.ts";
import { CodeFixStateSchema } from "./state.ts";
import type { CodeFixNodeFn, CodeFixState } from "./state.ts";

/**
 * Decision 2: the most nodes one attempt can visit, with both author loops used to the `maxAuthorAttempts` ceiling
 * (config can only lower it): eligibility, locate, workspace and baseline (4); author_test, guard_test and repro per
 * test attempt (3 each); author_patch, guard_patch and verify per patch attempt (3 each); then review, finalize and
 * fix_give_up (3, a finalize failure being the longest ending). 25 at the ceiling of 3.
 */
export const CODE_FIX_LONGEST_PATH = 4 + 3 * CODE_FIX_CEILINGS.maxAuthorAttempts + 3 * CODE_FIX_CEILINGS.maxAuthorAttempts + 3;

/**
 * Decision 2: the most supersteps an attempt may take. LangGraph raises GraphRecursionError once a run of N nodes meets
 * `recursionLimit: N`, so the limit must exceed the longest path; 4 more is margin. The routes already bound every loop,
 * so this is only a backstop, and a legitimate path never ends as `budget_exhausted` through it.
 */
export const CODE_FIX_RECURSION_LIMIT = CODE_FIX_LONGEST_PATH + 1 + 4;

export type CodeFixGraphNodes = Record<FixNodeId, CodeFixNodeFn>;

export type CodeFixGraphDeps = { limits: FixRouteLimits };

export type CodeFixRunOptions = {
  recursionLimit: number;
  /** The attempt's signal (timeout and shutdown); handed to the nodes only. */
  signal: AbortSignal;
  requestId: string | null;
};

/** What the service uses from the compiled graph: the stream of full states (one per superstep), or the last one. */
export interface CompiledCodeFixGraph {
  stream(input: CodeFixState, o: CodeFixRunOptions): Promise<AsyncIterable<CodeFixState>>;
  invoke(input: CodeFixState, o: CodeFixRunOptions): Promise<CodeFixState>;
}

/** Where the attempt's signal travels inside LangGraph's config. */
type FixConfigurable = { requestId: string | null; attemptSignal: AbortSignal };

/** The route of each origin; the limits are bound at build time. */
function routesOf(limits: FixRouteLimits): Record<FixNodeId, (s: CodeFixState) => FixRoute> {
  return {
    fix_eligibility: afterEligibility,
    fix_locate: afterLocate,
    fix_workspace: afterWorkspace,
    fix_baseline: (s) => afterBaseline(s, limits),
    fix_author_test: afterAuthorTest,
    fix_guard_test: (s) => afterGuardTest(s, limits),
    fix_repro: (s) => afterRepro(s, limits),
    fix_author_patch: afterAuthorPatch,
    fix_guard_patch: (s) => afterGuardPatch(s, limits),
    fix_verify: (s) => afterVerify(s, limits),
    fix_review: afterReview,
    fix_finalize: afterFinalize,
    fix_give_up: () => FIX_END,
  };
}

/** pathMap of an edge: each possible destination to its node id (END stays as is). */
function pathMap(targets: readonly FixRoute[]): Record<string, string> {
  return Object.fromEntries(targets.map((t) => [t, t === FIX_END ? END : t]));
}

/** The node's view of LangGraph's config: the attempt's signal and request id. */
function nodeConfig(cfg: unknown): NodeConfig {
  const c = (cfg as { configurable?: Partial<FixConfigurable> } | undefined)?.configurable;
  return {
    ...(c?.attemptSignal ? { signal: c.attemptSignal } : {}),
    configurable: { requestId: c?.requestId ?? null },
  };
}

export function buildCodeFixGraph(nodes: CodeFixGraphNodes, d: CodeFixGraphDeps): CompiledCodeFixGraph {
  for (const id of FIX_NODE_IDS) {
    if (typeof nodes[id] !== "function") throw new Error(`buildCodeFixGraph: missing node ${id}`);
  }
  const routes = routesOf(d.limits);
  const g = new StateGraph(CodeFixStateSchema);
  for (const id of FIX_NODE_IDS) {
    const node = nodes[id];
    g.addNode(id, (s: CodeFixState, cfg?: unknown) => node(s, nodeConfig(cfg)));
  }
  const graph = g as unknown as StateGraph<typeof CodeFixStateSchema, CodeFixState, Partial<CodeFixState>, string>;

  graph.addEdge(START, "fix_eligibility");
  for (const id of FIX_NODE_IDS) {
    const route = routes[id];
    graph.addConditionalEdges(id, (s: CodeFixState) => route(s), pathMap(FIX_EDGE_TARGETS[id]));
  }

  const compiled = graph.compile();
  const config = (o: CodeFixRunOptions) => ({
    recursionLimit: o.recursionLimit,
    configurable: { requestId: o.requestId, attemptSignal: o.signal } satisfies FixConfigurable,
  });
  return {
    async stream(input, o) {
      return (await compiled.stream(input, { ...config(o), streamMode: "values" })) as unknown as AsyncIterable<CodeFixState>;
    },
    async invoke(input, o) {
      return (await compiled.invoke(input, config(o))) as unknown as CodeFixState;
    },
  };
}
