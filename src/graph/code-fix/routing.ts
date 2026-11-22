// Code fixer routes (spec 009, decisions 2, 8 and 17). Pure functions: the state (and limits) in, a node id out.
// A node that sets `failure` diverts to fix_give_up on its edge, except the retry edges of decision 8. Every edge into
// an LLM node checks `budgetExceeded` first and goes to fix_give_up when the budget is spent.
import type { CodeFixReason, CodeFixStage } from "../../contracts/index.ts";
import { budgetExceeded } from "../../domain/code-fix/budget.ts";
import type { CodeFixLimits } from "../../domain/code-fix/limits.ts";
import type { CodeFixState } from "./state.ts";

/** Node ids registered in LangGraph; the `fix_` prefix keeps them apart from state keys. */
export const FIX_NODE_IDS = [
  "fix_eligibility", "fix_locate", "fix_workspace", "fix_baseline", "fix_author_test", "fix_guard_test", "fix_repro",
  "fix_author_patch", "fix_guard_patch", "fix_verify", "fix_review", "fix_finalize", "fix_give_up",
] as const;
export type FixNodeId = (typeof FIX_NODE_IDS)[number];

/** The nodes that call the LLM; every edge into one checks the budget. */
export const LLM_NODE_IDS = ["fix_author_test", "fix_author_patch", "fix_review"] as const satisfies readonly FixNodeId[];

/** Value of END in LangGraph. */
export const FIX_END = "__end__";
export type FixRoute = FixNodeId | typeof FIX_END;

export type FixRouteLimits = Pick<CodeFixLimits, "maxAuthorAttempts" | "maxLlmCalls" | "maxTokens">;

/** Every destination each origin can route to, for the explicit pathMap of each `addConditionalEdges`. */
export const FIX_EDGE_TARGETS = {
  fix_eligibility: ["fix_locate", "fix_give_up"],
  fix_locate: ["fix_workspace", "fix_give_up"],
  fix_workspace: ["fix_baseline", "fix_give_up"],
  fix_baseline: ["fix_author_test", "fix_give_up"],
  fix_author_test: ["fix_guard_test", "fix_give_up"],
  fix_guard_test: ["fix_repro", "fix_author_test", "fix_give_up"],
  fix_repro: ["fix_author_patch", "fix_author_test", "fix_give_up"],
  fix_author_patch: ["fix_guard_patch", "fix_give_up"],
  fix_guard_patch: ["fix_verify", "fix_author_patch", "fix_give_up"],
  fix_verify: ["fix_review", "fix_author_patch", "fix_give_up"],
  fix_review: ["fix_finalize", "fix_give_up"],
  fix_finalize: [FIX_END, "fix_give_up"],
  fix_give_up: [FIX_END],
} as const satisfies Record<FixNodeId, readonly FixRoute[]>;

type TestRetryStage = "guard_test" | "repro";
type PatchRetryStage = "guard_patch" | "verify";

/** Decision 8: failures that send the test author back, per stage. */
const TEST_RETRY: Record<TestRetryStage, readonly CodeFixReason[]> = {
  guard_test: ["guard_rejected"],
  repro: ["repro_not_failing", "repro_wrong_reason"],
};

/** Decision 8: failures that send the patch author back, per stage. */
const PATCH_RETRY: Record<PatchRetryStage, readonly CodeFixReason[]> = {
  guard_patch: ["guard_rejected", "edit_not_applicable"],
  verify: ["edit_not_applicable", "fix_not_passing"],
};

const isIn = <K extends string>(rec: Record<K, readonly CodeFixReason[]>, stage: CodeFixStage): stage is K & CodeFixStage =>
  Object.hasOwn(rec, stage);

/**
 * The author to send the attempt back to, when the failure is retryable at its stage and that author has calls left;
 * else null. It ignores the budget: the caller checks it (and `giveUpReason` names it when it is what stopped the retry).
 */
export function retryTarget(s: CodeFixState, limits: FixRouteLimits): "fix_author_test" | "fix_author_patch" | null {
  const f = s.failure;
  if (f === null) return null;
  if (isIn(TEST_RETRY, s.stage) && TEST_RETRY[s.stage].includes(f) && s.authorTestCalls < limits.maxAuthorAttempts) return "fix_author_test";
  if (isIn(PATCH_RETRY, s.stage) && PATCH_RETRY[s.stage].includes(f) && s.authorPatchCalls < limits.maxAuthorAttempts) return "fix_author_patch";
  return null;
}

/** An edge into an LLM node: the node when the budget allows it, else give-up. */
function intoLlm<T extends FixNodeId>(s: CodeFixState, limits: FixRouteLimits, target: T): T | "fix_give_up" {
  return budgetExceeded(s, limits) ? "fix_give_up" : target;
}

/** A failure at a stage with retry edges: retry while allowed and affordable; any other failure gives up. */
function withRetry<T extends FixNodeId>(s: CodeFixState, limits: FixRouteLimits, onSuccess: T): T | "fix_author_test" | "fix_author_patch" | "fix_give_up" {
  if (s.failure === null) return onSuccess;
  const retry = retryTarget(s, limits);
  return retry === null ? "fix_give_up" : intoLlm(s, limits, retry);
}

const plain = <T extends FixNodeId>(s: CodeFixState, next: T): T | "fix_give_up" => (s.failure === null ? next : "fix_give_up");

export function afterEligibility(s: CodeFixState): "fix_locate" | "fix_give_up" {
  return plain(s, "fix_locate");
}

export function afterLocate(s: CodeFixState): "fix_workspace" | "fix_give_up" {
  return plain(s, "fix_workspace");
}

export function afterWorkspace(s: CodeFixState): "fix_baseline" | "fix_give_up" {
  return plain(s, "fix_baseline");
}

/** AC-67: a baseline that is not green never reaches the LLM. */
export function afterBaseline(s: CodeFixState, limits: FixRouteLimits): "fix_author_test" | "fix_give_up" {
  return s.failure === null ? intoLlm(s, limits, "fix_author_test") : "fix_give_up";
}

export function afterAuthorTest(s: CodeFixState): "fix_guard_test" | "fix_give_up" {
  return plain(s, "fix_guard_test");
}

export function afterGuardTest(s: CodeFixState, limits: FixRouteLimits): "fix_repro" | "fix_author_test" | "fix_give_up" {
  return withRetry(s, limits, "fix_repro") as "fix_repro" | "fix_author_test" | "fix_give_up";
}

/** right_reason continues to the patch author; not failing or wrong reason retries the test author; flaky never retries. */
export function afterRepro(s: CodeFixState, limits: FixRouteLimits): "fix_author_patch" | "fix_author_test" | "fix_give_up" {
  if (s.failure === null) return intoLlm(s, limits, "fix_author_patch");
  return withRetry(s, limits, "fix_author_patch") as "fix_author_patch" | "fix_author_test" | "fix_give_up";
}

export function afterAuthorPatch(s: CodeFixState): "fix_guard_patch" | "fix_give_up" {
  return plain(s, "fix_guard_patch");
}

export function afterGuardPatch(s: CodeFixState, limits: FixRouteLimits): "fix_verify" | "fix_author_patch" | "fix_give_up" {
  return withRetry(s, limits, "fix_verify") as "fix_verify" | "fix_author_patch" | "fix_give_up";
}

/** fix_flaky, suite_regressed, test_count_dropped and the diff rules never retry. */
export function afterVerify(s: CodeFixState, limits: FixRouteLimits): "fix_review" | "fix_author_patch" | "fix_give_up" {
  if (s.failure === null) return intoLlm(s, limits, "fix_review");
  return withRetry(s, limits, "fix_review") as "fix_review" | "fix_author_patch" | "fix_give_up";
}

export function afterReview(s: CodeFixState): "fix_finalize" | "fix_give_up" {
  return plain(s, "fix_finalize");
}

export function afterFinalize(s: CodeFixState): typeof FIX_END | "fix_give_up" {
  return s.failure === null && s.outcome.status === "patch_ready" ? FIX_END : "fix_give_up";
}

/**
 * The reason fix_give_up records. `budget_exhausted` when the budget, not the failure, stopped the attempt: an edge into
 * an LLM node with no failure, or a retry the attempt counts still allowed. Otherwise the failure itself.
 */
export function giveUpReason(s: CodeFixState, limits: FixRouteLimits): CodeFixReason {
  if (s.failure === null) return "budget_exhausted";
  if (retryTarget(s, limits) !== null && budgetExceeded(s, limits)) return "budget_exhausted";
  return s.failure;
}
