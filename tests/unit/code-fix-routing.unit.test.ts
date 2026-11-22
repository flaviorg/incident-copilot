// Code fixer routes (spec 009, decisions 2, 8 and 17; AC-67, AC-69, AC-70, AC-81). Pure: state (and limits) in, node id out.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { CodeFixReason, CodeFixStage } from "../../src/contracts/index.ts";
import { CODE_FIX_DEFAULT_LIMITS } from "../../src/domain/code-fix/limits.ts";
import {
  afterAuthorPatch, afterAuthorTest, afterBaseline, afterEligibility, afterFinalize, afterGuardPatch, afterGuardTest, afterLocate,
  afterRepro, afterReview, afterVerify, afterWorkspace, FIX_EDGE_TARGETS, FIX_END, FIX_NODE_IDS, giveUpReason, retryTarget,
} from "../../src/graph/code-fix/routing.ts";
import type { FixRouteLimits } from "../../src/graph/code-fix/routing.ts";
import { CodeFixStateSchema } from "../../src/graph/code-fix/state.ts";
import type { CodeFixState } from "../../src/graph/code-fix/state.ts";
import { locatedState } from "../helpers/code-fix-fakes.ts";

const limits: FixRouteLimits = {
  maxAuthorAttempts: CODE_FIX_DEFAULT_LIMITS.maxAuthorAttempts, // 2
  maxLlmCalls: CODE_FIX_DEFAULT_LIMITS.maxLlmCalls, // 6
  maxTokens: CODE_FIX_DEFAULT_LIMITS.maxTokens, // 60,000
};

const at = (stage: CodeFixStage, over: Partial<CodeFixState> = {}): CodeFixState => locatedState({ stage, failure: null, ...over });
const failed = (stage: CodeFixStage, failure: CodeFixReason, over: Partial<CodeFixState> = {}): CodeFixState => at(stage, { failure, ...over });
const spent = { calls: 6, promptTokens: 100, completionTokens: 100 };
const tokensSpent = { calls: 1, promptTokens: 50_000, completionTokens: 10_000 };

describe("node ids and edges", () => {
  test("every node id has the fix_ prefix and none equals a state key", () => {
    const keys = new Set(Object.keys(CodeFixStateSchema.shape));
    for (const id of FIX_NODE_IDS) {
      assert.match(id, /^fix_[a-z_]+$/);
      assert.equal(keys.has(id), false, id);
    }
    assert.equal(new Set(FIX_NODE_IDS).size, FIX_NODE_IDS.length);
  });

  test("every origin except give-up can route to fix_give_up, and give-up only ends", () => {
    for (const [origin, targets] of Object.entries(FIX_EDGE_TARGETS)) {
      assert.ok((FIX_NODE_IDS as readonly string[]).includes(origin), origin);
      if (origin === "fix_give_up") assert.deepEqual([...targets], [FIX_END]);
      else assert.ok((targets as readonly string[]).includes("fix_give_up"), origin);
    }
    const origins = Object.keys(FIX_EDGE_TARGETS).sort();
    assert.deepEqual(origins, [...FIX_NODE_IDS].sort());
  });

  test("routes are pure: the same state gives the same id and the state is not mutated", () => {
    const s = failed("guard_test", "guard_rejected", { authorTestCalls: 1 });
    const before = structuredClone(s);
    assert.equal(afterGuardTest(s, limits), afterGuardTest(s, limits));
    assert.deepEqual(s, before);
  });
});

describe("deterministic early stages", () => {
  test("eligibility: a skip reason gives up, otherwise locate", () => {
    assert.equal(afterEligibility(at("eligibility")), "fix_locate");
    assert.equal(afterEligibility(failed("eligibility", "category_not_code")), "fix_give_up");
  });

  test("locate: any skip reason gives up, otherwise workspace", () => {
    assert.equal(afterLocate(at("locate")), "fix_workspace");
    for (const r of ["error_event_unavailable", "exception_not_fixable", "not_new_in_release", "no_in_app_frame", "path_not_allowlisted",
      "path_denied", "commit_unresolved", "commit_not_found"] as const) {
      assert.equal(afterLocate(failed("locate", r)), "fix_give_up", r);
    }
  });

  test("workspace: a failure gives up, otherwise baseline", () => {
    assert.equal(afterWorkspace(at("workspace")), "fix_baseline");
    for (const r of ["workspace_failed", "file_changed_since_release", "line_out_of_range", "file_not_regular"] as const) {
      assert.equal(afterWorkspace(failed("workspace", r)), "fix_give_up", r);
    }
  });

  test("baseline: a failure gives up before any LLM call (AC-67)", () => {
    for (const r of ["baseline_not_green", "baseline_timeout", "sandbox_error"] as const) {
      assert.equal(afterBaseline(failed("baseline", r), limits), "fix_give_up", r);
    }
    assert.equal(afterBaseline(at("baseline"), limits), "fix_author_test");
  });
});

describe("test author loop", () => {
  test("author_test: an LLM failure gives up, otherwise guard_test", () => {
    assert.equal(afterAuthorTest(at("author_test", { authorTestCalls: 1 })), "fix_guard_test");
    assert.equal(afterAuthorTest(failed("author_test", "author_unavailable", { authorTestCalls: 1 })), "fix_give_up");
  });

  test("guard_test: a rejection retries the test author while attempts remain", () => {
    assert.equal(afterGuardTest(at("guard_test", { authorTestCalls: 1 }), limits), "fix_repro");
    assert.equal(afterGuardTest(failed("guard_test", "guard_rejected", { authorTestCalls: 1 }), limits), "fix_author_test");
    assert.equal(afterGuardTest(failed("guard_test", "guard_rejected", { authorTestCalls: 2 }), limits), "fix_give_up");
    assert.equal(afterGuardTest(failed("guard_test", "guard_rejected", { authorTestCalls: 2 }), { ...limits, maxAuthorAttempts: 3 }), "fix_author_test");
  });

  test("repro: not failing and wrong reason retry the test author; flaky and sandbox errors do not", () => {
    for (const r of ["repro_not_failing", "repro_wrong_reason"] as const) {
      assert.equal(afterRepro(failed("repro", r, { authorTestCalls: 1 }), limits), "fix_author_test", r);
      assert.equal(afterRepro(failed("repro", r, { authorTestCalls: 2 }), limits), "fix_give_up", r);
    }
    for (const r of ["repro_flaky", "sandbox_error", "attempt_timeout"] as const) {
      assert.equal(afterRepro(failed("repro", r, { authorTestCalls: 1 }), limits), "fix_give_up", r);
    }
    assert.equal(afterRepro(at("repro", { authorTestCalls: 1 }), limits), "fix_author_patch");
  });
});

describe("patch author loop", () => {
  test("author_patch: an LLM failure gives up, otherwise guard_patch", () => {
    assert.equal(afterAuthorPatch(at("author_patch", { authorPatchCalls: 1 })), "fix_guard_patch");
    assert.equal(afterAuthorPatch(failed("author_patch", "author_unavailable", { authorPatchCalls: 1 })), "fix_give_up");
  });

  test("guard_patch: a rejection or a non-applicable edit retries the patch author while attempts remain", () => {
    assert.equal(afterGuardPatch(at("guard_patch", { authorPatchCalls: 1 }), limits), "fix_verify");
    for (const r of ["guard_rejected", "edit_not_applicable"] as const) {
      assert.equal(afterGuardPatch(failed("guard_patch", r, { authorPatchCalls: 1 }), limits), "fix_author_patch", r);
      assert.equal(afterGuardPatch(failed("guard_patch", r, { authorPatchCalls: 2 }), limits), "fix_give_up", r);
    }
  });

  test("verify: edit_not_applicable and fix_not_passing retry; flaky, regressed and dropped counts do not", () => {
    for (const r of ["edit_not_applicable", "fix_not_passing"] as const) {
      assert.equal(afterVerify(failed("verify", r, { authorPatchCalls: 1 }), limits), "fix_author_patch", r);
      assert.equal(afterVerify(failed("verify", r, { authorPatchCalls: 2 }), limits), "fix_give_up", r);
    }
    for (const r of ["fix_flaky", "suite_regressed", "test_count_dropped", "unexpected_file", "patch_too_large", "patch_contains_secret", "guard_rejected"] as const) {
      assert.equal(afterVerify(failed("verify", r, { authorPatchCalls: 1 }), limits), "fix_give_up", r);
    }
    assert.equal(afterVerify(at("verify", { authorPatchCalls: 1 }), limits), "fix_review");
  });

  test("a test-author reason at a patch stage does not retry the test author", () => {
    assert.equal(retryTarget(failed("verify", "repro_not_failing", { authorTestCalls: 1 }), limits), null);
    assert.equal(retryTarget(failed("repro", "fix_not_passing", { authorPatchCalls: 1 }), limits), null);
    assert.equal(retryTarget(failed("guard_test", "guard_rejected", { authorTestCalls: 1 }), limits), "fix_author_test");
    assert.equal(retryTarget(failed("guard_patch", "guard_rejected", { authorPatchCalls: 1 }), limits), "fix_author_patch");
  });
});

describe("review and finalize", () => {
  test("review: reject or unavailable gives up, approve finalizes", () => {
    assert.equal(afterReview(at("review")), "fix_finalize");
    assert.equal(afterReview(failed("review", "reviewer_rejected")), "fix_give_up");
    assert.equal(afterReview(failed("review", "reviewer_unavailable")), "fix_give_up");
  });

  test("finalize: a refusal gives up, success ends", () => {
    assert.equal(afterFinalize(at("finalize", { outcome: { status: "patch_ready", reason: null } })), FIX_END);
    assert.equal(afterFinalize(failed("finalize", "catalog_refused")), "fix_give_up");
    assert.equal(afterFinalize(failed("finalize", "guard_rejected")), "fix_give_up");
  });
});

describe("budget before every LLM node (decision 17, AC-81)", () => {
  test("an exhausted call or token budget diverts every edge into an LLM node to give-up", () => {
    for (const llm of [spent, tokensSpent]) {
      assert.equal(afterBaseline(at("baseline", { llm }), limits), "fix_give_up");
      assert.equal(afterGuardTest(failed("guard_test", "guard_rejected", { llm, authorTestCalls: 1 }), limits), "fix_give_up");
      assert.equal(afterRepro(failed("repro", "repro_wrong_reason", { llm, authorTestCalls: 1 }), limits), "fix_give_up");
      assert.equal(afterRepro(at("repro", { llm, authorTestCalls: 1 }), limits), "fix_give_up");
      assert.equal(afterGuardPatch(failed("guard_patch", "guard_rejected", { llm, authorPatchCalls: 1 }), limits), "fix_give_up");
      assert.equal(afterVerify(failed("verify", "fix_not_passing", { llm, authorPatchCalls: 1 }), limits), "fix_give_up");
      assert.equal(afterVerify(at("verify", { llm, authorPatchCalls: 1 }), limits), "fix_give_up");
    }
  });

  test("edges into deterministic nodes ignore the budget", () => {
    assert.equal(afterAuthorTest(at("author_test", { llm: spent, authorTestCalls: 1 })), "fix_guard_test");
    assert.equal(afterGuardTest(at("guard_test", { llm: spent, authorTestCalls: 1 }), limits), "fix_repro");
    assert.equal(afterAuthorPatch(at("author_patch", { llm: spent, authorPatchCalls: 1 })), "fix_guard_patch");
    assert.equal(afterGuardPatch(at("guard_patch", { llm: spent, authorPatchCalls: 1 }), limits), "fix_verify");
    assert.equal(afterReview(at("review", { llm: spent })), "fix_finalize");
  });

  test("the give-up reason is budget_exhausted when the budget, not the failure, stopped the attempt", () => {
    assert.equal(giveUpReason(at("baseline", { llm: spent }), limits), "budget_exhausted");
    assert.equal(giveUpReason(failed("guard_test", "guard_rejected", { llm: spent, authorTestCalls: 1 }), limits), "budget_exhausted");
    assert.equal(giveUpReason(failed("verify", "fix_not_passing", { llm: tokensSpent, authorPatchCalls: 1 }), limits), "budget_exhausted");
    // Retries used up: the failure itself is the reason, whatever the budget.
    assert.equal(giveUpReason(failed("guard_test", "guard_rejected", { llm: spent, authorTestCalls: 2 }), limits), "guard_rejected");
    assert.equal(giveUpReason(failed("repro", "repro_flaky", { llm: spent, authorTestCalls: 1 }), limits), "repro_flaky");
    assert.equal(giveUpReason(failed("locate", "commit_not_found"), limits), "commit_not_found");
  });
});
