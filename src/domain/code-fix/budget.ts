// LLM budget of one code-fix attempt (spec 009, decision 17; AC-81). Pure. Runs in every route before an LLM node,
// so "at the limit" already counts as exhausted: the next call would go over it.

export type BudgetState = { llm: { calls: number; promptTokens: number; completionTokens: number } };
export type BudgetLimits = { maxLlmCalls: number; maxTokens: number };

export function budgetExceeded(state: BudgetState, limits: BudgetLimits): boolean {
  const tokens = state.llm.promptTokens + state.llm.completionTokens;
  return state.llm.calls >= limits.maxLlmCalls || tokens >= limits.maxTokens;
}
