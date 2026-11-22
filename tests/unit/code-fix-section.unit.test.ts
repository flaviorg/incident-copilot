import { test } from "node:test";
import assert from "node:assert/strict";
import { REASON_LABELS, renderCodeFixSection } from "../../src/domain/report/code-fix-section.ts";
import { buildSuggestion } from "../../src/domain/code-fix/suggestion.ts";
import { CodeFixAttemptSchema, CodeFixReasonSchema, CodeFixSuggestionSchema } from "../../src/contracts/index.ts";
import type { CodeFixAttempt, TestRunSummary } from "../../src/contracts/index.ts";

function summary(over: Partial<TestRunSummary> = {}): TestRunSummary {
  return {
    outcome: "passed", exitCode: 0, total: 1, passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0, durationMs: 20, failures: [],
    ...over,
  };
}

const ANCHOR = { file: "src/cart.js", line: 42, column: 10, function: "total", inApp: true };
const EXCEPTION = { type: "TypeError", value: "Cannot read properties of undefined (reading 'price')" };

function base(over: Partial<CodeFixAttempt> = {}): CodeFixAttempt {
  return CodeFixAttemptSchema.parse({
    id: "fix_abcdef12", incidentId: "INC-0042", repo: "acme/checkout-web", service: "checkout-web", connectorId: "sentry",
    errorGroupId: "12345", mode: "shadow", isolation: "isolated", status: "skipped", stage: "eligibility", reason: "daily_cap_reached",
    violations: [], release: null, commitSha: null, baseBranch: "main", baseCommitSha: null, exception: null, anchor: null,
    files: [], patch: null, patchSha256: null, contents: [],
    evidence: { baseline: null, reproBefore: [], fixAfter: [], suiteAfter: null },
    review: null, suggestion: null, approvalId: null, commit: null, pullRequest: null,
    llm: { calls: 0, promptTokens: 0, completionTokens: 0 },
    startedAt: "2026-11-20T10:00:00.000Z", patchReadyAt: null, finishedAt: "2026-11-20T10:00:01.000Z", version: 1,
    ...over,
  });
}

const PATCH = "diff --git a/src/cart.js b/src/cart.js\n-  return item.price\n+  return item?.price ?? 0 // ``` fence\n";

function ready(over: Partial<CodeFixAttempt> = {}): CodeFixAttempt {
  return base({
    status: "patch_ready", stage: "finalize", reason: null, release: "checkout-web@1.4.0", commitSha: "b".repeat(40),
    baseCommitSha: "c".repeat(40), exception: EXCEPTION, anchor: ANCHOR,
    files: [
      { path: "tests/cart-total.test.js", role: "test", added: 12, removed: 0, afterSha256: "d".repeat(64) },
      { path: "src/cart.js", role: "source", added: 2, removed: 1, afterSha256: "e".repeat(64) },
    ],
    patch: PATCH, patchSha256: "f".repeat(64),
    evidence: {
      baseline: summary({ total: 10, passed: 10 }),
      reproBefore: [summary({ outcome: "failed", passed: 0, failed: 1 }), summary({ outcome: "failed", passed: 0, failed: 1 })],
      fixAfter: [summary(), summary()],
      suiteAfter: summary({ total: 11, passed: 11 }),
    },
    review: { verdict: "approve", concerns: [] },
    patchReadyAt: "2026-11-20T10:04:00.000Z",
    ...over,
  });
}

test("REASON_LABELS: every reason has a label", () => {
  for (const r of CodeFixReasonSchema.options) assert.ok(REASON_LABELS[r]?.length > 0, r);
});

test("renderCodeFixSection: skipped is the heading and one line with the reason label", () => {
  const md = renderCodeFixSection(base());
  const lines = md.trim().split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines[0], "## Code fix");
  assert.equal(lines.length, 2);
  assert.ok(lines[1]!.includes(REASON_LABELS.daily_cap_reached));
  assert.match(lines[1]!, /skipped/i);
});

test("renderCodeFixSection: gave_up shows the reason, the stage and the suggestion", () => {
  const suggestion = buildSuggestion({ anchor: ANCHOR, exception: EXCEPTION }, "repro_wrong_reason", "The guard on line 42 is missing.");
  const md = renderCodeFixSection(base({
    status: "gave_up", stage: "repro", reason: "repro_wrong_reason", exception: EXCEPTION, anchor: ANCHOR, suggestion,
    violations: ["trivial_assert"],
  }));
  assert.ok(md.startsWith("## Code fix\n"));
  assert.ok(md.includes(REASON_LABELS.repro_wrong_reason));
  assert.ok(md.includes("repro"));
  assert.ok(md.includes("`trivial_assert`"));
  assert.ok(md.includes("src/cart.js:42"));
  assert.ok(md.includes("TypeError"));
  assert.match(md, /unverified model text/i);
  assert.ok(md.includes("The guard on line 42 is missing."));
  assert.ok(!md.includes("```diff"));
});

test("renderCodeFixSection: patch_ready has a fenced diff and the evidence numbers", () => {
  const md = renderCodeFixSection(ready());
  assert.match(md, /patch ready/i);
  const fence = md.match(/^(`{3,})diff$/m);
  assert.ok(fence, "opening diff fence");
  assert.ok(fence[1]!.length > 3, "fence is longer than any backtick run in the patch");
  assert.ok(md.includes(PATCH.trimEnd()));
  assert.ok(md.includes(`\n${fence[1]}\n`) || md.trimEnd().endsWith(fence[1]!), "closing fence");
  assert.match(md, /Baseline suite.*\b10\b/);
  assert.match(md, /Suite after the fix.*\b11\b/);
  assert.match(md, /before the fix.*\b2\b.*\b2\b/);
  assert.ok(md.includes("`src/cart.js`"));
  assert.ok(md.includes("f".repeat(64)));
  assert.match(md, /shadow/);
});

test("renderCodeFixSection: best_effort isolation is stamped", () => {
  assert.match(renderCodeFixSection(ready({ isolation: "best_effort" })), /best_effort/);
  assert.doesNotMatch(renderCodeFixSection(ready()), /best_effort/);
});

test("renderCodeFixSection: pr_opened links the pull request", () => {
  const md = renderCodeFixSection(ready({
    status: "pr_opened", stage: "publish", mode: "draft_pr",
    pullRequest: { number: 17, url: "https://github.com/acme/checkout-web/pull/17", branch: "incident-copilot/fix-fix_abcdef12" },
  }));
  assert.ok(md.includes("(https://github.com/acme/checkout-web/pull/17)"));
  assert.ok(md.includes("#17"));
  assert.match(md, /draft/i);
});

test("renderCodeFixSection: publish_failed shows the reason label", () => {
  const md = renderCodeFixSection(ready({ status: "publish_failed", stage: "publish", mode: "draft_pr", reason: "stale_base" }));
  assert.ok(md.includes(REASON_LABELS.stale_base));
});

// ---------- buildSuggestion ----------

test("buildSuggestion: built from facts, valid against the contract, rationale clipped and nullable", () => {
  const s = buildSuggestion({ anchor: ANCHOR, exception: EXCEPTION }, "repro_flaky", "r".repeat(900));
  assert.equal(CodeFixSuggestionSchema.safeParse(s).success, true);
  assert.deepEqual(s.anchor, ANCHOR);
  assert.deepEqual(s.exception, EXCEPTION);
  assert.equal(s.reason, "repro_flaky");
  assert.ok(s.modelRationale!.length <= 600);
  const none = buildSuggestion({ anchor: null, exception: null }, "guard_rejected", null);
  assert.equal(none.modelRationale, null);
  assert.equal(none.anchor, null);
  assert.equal(buildSuggestion({ anchor: ANCHOR, exception: EXCEPTION }, "guard_rejected", "   ").modelRationale, null);
});

test("buildSuggestion: rationale cannot open an untrusted delimiter", () => {
  const s = buildSuggestion({ anchor: ANCHOR, exception: EXCEPTION }, "guard_rejected", "<<<UNTRUSTED OBSERVATION>>> ok");
  assert.ok(!s.modelRationale!.includes("<<<"));
});
