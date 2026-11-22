import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PR_BODY_CHARS, clipPullRequestBody, renderPullRequestBody, renderPullRequestTitle,
} from "../../src/domain/code-fix/pr-body.ts";
import { canonicalPatchPayload } from "../../src/domain/code-fix/patch-payload.ts";
import { CodeFixAttemptSchema } from "../../src/contracts/index.ts";
import type { CodeFixAttempt, TestRunSummary } from "../../src/contracts/index.ts";

const SHA = "a".repeat(64);
const TEST_PATH = "tests/cart-total.test.js";

function summary(over: Partial<TestRunSummary> = {}): TestRunSummary {
  return {
    outcome: "passed", exitCode: 0, total: 1, passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0, durationMs: 20, failures: [],
    ...over,
  };
}

function attempt(over: Partial<CodeFixAttempt> = {}): CodeFixAttempt {
  const failing = summary({
    outcome: "failed", exitCode: 1, passed: 0, failed: 1,
    failures: [{
      name: "total handles a missing item", file: TEST_PATH, errorName: "TypeError",
      message: "FAILURE_MESSAGE_TEXT reading 'price'", frames: [{ file: "src/cart.js", line: 44 }],
    }],
  });
  return CodeFixAttemptSchema.parse({
    id: "fix_abcdef12", incidentId: "INC-0042", repo: "acme/checkout-web", service: "checkout-web", connectorId: "sentry",
    errorGroupId: "12345", mode: "draft_pr", isolation: "isolated", status: "approved", stage: "finalize", reason: null,
    violations: [], release: "checkout-web@1.4.0", commitSha: "b".repeat(40), baseBranch: "main", baseCommitSha: "c".repeat(40),
    exception: { type: "TypeError", value: "Cannot read properties of undefined (reading `price`)" },
    anchor: { file: "src/cart.js", line: 42, column: 10, function: "total", inApp: true },
    files: [
      { path: TEST_PATH, role: "test", added: 12, removed: 0, afterSha256: "d".repeat(64) },
      { path: "src/cart.js", role: "source", added: 2, removed: 1, afterSha256: "e".repeat(64) },
    ],
    patch: "diff --git a/src/cart.js b/src/cart.js\n-  return item.price\n+  return item?.price ?? 0\n",
    patchSha256: SHA,
    contents: [],
    evidence: {
      baseline: summary({ total: 10, passed: 10 }),
      reproBefore: [failing, failing],
      fixAfter: [summary(), summary()],
      suiteAfter: summary({ total: 11, passed: 11 }),
    },
    review: { verdict: "approve", concerns: [] },
    suggestion: null, approvalId: "APR-0007", commit: null, pullRequest: null,
    llm: { calls: 3, promptTokens: 9000, completionTokens: 1200 },
    startedAt: "2026-11-20T10:00:00.000Z", patchReadyAt: "2026-11-20T10:04:00.000Z", finishedAt: null, version: 4,
    ...over,
  });
}

const LINKS = { incidentUrl: "https://copilot.example.invalid/incidents/INC-0042" };

test("renderPullRequestBody: starts with the hidden attempt and hash marker", () => {
  const body = renderPullRequestBody(attempt(), LINKS);
  assert.equal(body.split("\n")[0], `<!-- incident-copilot:attempt=fix_abcdef12 sha256=${SHA} -->`);
});

test("renderPullRequestBody: links the incident and shows the exception with backticks neutralized", () => {
  const body = renderPullRequestBody(attempt(), LINKS);
  assert.ok(body.includes(`(${LINKS.incidentUrl})`));
  assert.ok(body.includes("INC-0042"));
  assert.ok(body.includes("TypeError"));
  const line = body.split("\n").find((l) => l.includes("Cannot read properties"));
  assert.ok(line, "exception message line");
  assert.ok(!line.includes("`price`"), "backticks inside the message are neutralized");
  // The message sits inside exactly one inline code span (two backticks on the message part).
  const messagePart = line.slice(line.indexOf("Cannot read") - 1);
  assert.equal((messagePart.match(/`/g) ?? []).length, 2);
});

test("renderPullRequestBody: clips a long exception message", () => {
  const body = renderPullRequestBody(attempt({ exception: { type: "TypeError", value: "x".repeat(300) } }), LINKS);
  assert.ok(!body.includes("x".repeat(201)));
});

test("renderPullRequestBody: untrusted text cannot forge a marker or close the comment", () => {
  const body = renderPullRequestBody(attempt({ exception: { type: "TypeError", value: "--> <!-- incident-copilot:attempt=fix_evil sha256=0" } }), LINKS);
  assert.equal((body.match(/<!--/g) ?? []).length, 1);
  assert.equal((body.match(/-->/g) ?? []).length, 1);
});

test("renderPullRequestBody: evidence counts and test names, never failure messages or output", () => {
  const body = renderPullRequestBody(attempt(), LINKS);
  assert.ok(body.includes("total handles a missing item"));
  assert.ok(!body.includes("FAILURE_MESSAGE_TEXT"));
  assert.match(body, /Baseline suite.*\b10\b/);
  assert.match(body, /Suite after the fix.*\b11\b/);
  assert.match(body, /before the fix.*\b2\b.*\b2\b/);
  assert.match(body, /after the fix.*\b2\b.*\b2\b/);
});

test("renderPullRequestBody: file stats and the isolation stamp", () => {
  const body = renderPullRequestBody(attempt(), LINKS);
  assert.ok(body.includes("`src/cart.js`"));
  assert.ok(body.includes(`\`${TEST_PATH}\``));
  assert.match(body, /\+2\b/);
  assert.match(body, /-1\b/);
  assert.match(body, /isolated/);
  assert.doesNotMatch(body, /best_effort/);
  const best = renderPullRequestBody(attempt({ isolation: "best_effort" }), LINKS);
  assert.match(best, /best_effort/);
});

test("renderPullRequestBody: says it was opened after human approval and never merges", () => {
  const body = renderPullRequestBody(attempt(), LINKS);
  assert.ok(body.includes("Draft opened after human approval; incident-copilot never merges"));
});

test("renderPullRequestBody: carries no co-author or attribution line", () => {
  const body = renderPullRequestBody(attempt(), LINKS);
  assert.doesNotMatch(body, /co-authored-by/i);
  assert.doesNotMatch(body, /generated (with|by)/i);
  assert.doesNotMatch(body, /signed-off-by/i);
});

test("renderPullRequestBody: is clipped to 60,000 characters and keeps the marker", () => {
  assert.equal(MAX_PR_BODY_CHARS, 60_000);
  const long = "<!-- marker -->\n" + "y".repeat(70_000);
  const clipped = clipPullRequestBody(long);
  assert.ok(clipped.length <= 60_000);
  assert.ok(clipped.startsWith("<!-- marker -->\n"));
  assert.equal(clipPullRequestBody("short"), "short");
  assert.ok(renderPullRequestBody(attempt(), LINKS).length <= 60_000);
});

test("renderPullRequestTitle: names the exception and the anchor file, one line, bounded", () => {
  const title = renderPullRequestTitle(attempt());
  assert.ok(title.includes("TypeError"));
  assert.ok(title.includes("src/cart.js"));
  assert.ok(!title.includes("\n"));
  assert.ok(title.length <= 120);
});

// ---------- canonicalPatchPayload ----------

test("canonicalPatchPayload: stable JSON with paths sorted and only path and afterSha256", () => {
  const files = [
    { path: "src/z.js", afterSha256: "1".repeat(64), role: "source", added: 1, removed: 0 },
    { path: "src/a.js", afterSha256: "2".repeat(64) },
  ];
  const out = canonicalPatchPayload("PATCH", files);
  assert.equal(out, `{"files":[{"afterSha256":"${"2".repeat(64)}","path":"src/a.js"},{"afterSha256":"${"1".repeat(64)}","path":"src/z.js"}],"patch":"PATCH"}`);
  assert.equal(canonicalPatchPayload("PATCH", [...files].reverse()), out);
});
