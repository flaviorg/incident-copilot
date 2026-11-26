// "Code fix" section appended to the postmortem Markdown (spec 009; AC-74). Pure. Facts, counts and the patch from
// the work tree; untrusted text is sanitized and fenced. The caller applies `redactSecrets` to the result.
import type { CodeFixAttempt, CodeFixAttemptView, CodeFixReason, CodeFixStatus } from "../../contracts/index.ts";
import {
  anchorLine, evidenceLines, exceptionLine, fileTable, inlineCode, isolationLine,
} from "../code-fix/pr-body.ts";

type AttemptLike = CodeFixAttempt | CodeFixAttemptView;

export const REASON_LABELS: Record<CodeFixReason, string> = {
  not_advised: "the incident did not end advised, or it escalated",
  source_unsupported: "the alert is not a Sentry issue alert",
  category_not_code: "the diagnosis is not a faulty deploy",
  low_confidence: "the diagnosis confidence is low",
  service_not_allowlisted: "the service has no allowlisted repository",
  connector_unsupported: "the connector cannot read error events, release commits or deploys",
  sandbox_unavailable: "the test sandbox is unavailable",
  daily_cap_reached: "the repository's daily attempt cap is reached",
  already_attempted: "an attempt already holds this error group",
  error_event_unavailable: "the latest error event could not be read",
  exception_not_fixable: "the exception type is not in the fixable list",
  not_new_in_release: "the error is not new in the failing release",
  no_in_app_frame: "the stack trace has no in-app frame",
  path_not_allowlisted: "the anchor file is outside the source globs",
  path_denied: "the anchor file is in a denied path",
  commit_unresolved: "the release commit could not be resolved",
  commit_not_found: "the code host does not know the release commit",
  workspace_failed: "the workspace could not be prepared",
  file_changed_since_release: "the anchor file changed since the release",
  line_out_of_range: "the anchor line is outside the file",
  file_not_regular: "the anchor file is not a regular file",
  baseline_not_green: "the baseline suite did not pass",
  baseline_timeout: "the baseline suite timed out",
  sandbox_error: "the test sandbox failed",
  author_unavailable: "the model did not return a usable proposal",
  budget_exhausted: "the LLM call or token budget is exhausted",
  attempt_timeout: "the attempt timed out",
  guard_rejected: "the guards rejected every proposal",
  repro_not_failing: "the regression test did not fail",
  repro_wrong_reason: "the regression test failed for the wrong reason",
  repro_flaky: "the regression test was flaky",
  edit_not_applicable: "the proposed edit did not apply",
  fix_not_passing: "the regression test did not pass after the fix",
  fix_flaky: "the regression test was flaky after the fix",
  suite_regressed: "the suite failed after the fix",
  test_count_dropped: "the suite's test counts changed unexpectedly",
  unexpected_file: "the work tree changed an unexpected file",
  patch_too_large: "a changed file is too large",
  patch_contains_secret: "the patch contains a secret",
  reviewer_rejected: "the reviewer rejected the patch",
  reviewer_unavailable: "the reviewer was unavailable",
  catalog_refused: "the action catalog refused the step",
  interrupted: "the process restarted during the attempt",
  patch_mismatch: "the stored patch does not match the approved hash",
  base_unprotected: "the base branch is not protected",
  stale_base: "the patched files changed on the base branch",
  ref_conflict: "the fix branch exists with other content",
  codehost_error: "the code host returned an error",
};

const STATUS_LABELS: Record<CodeFixStatus, string> = {
  skipped: "skipped",
  running: "in progress",
  gave_up: "gave up",
  patch_ready: "patch ready",
  awaiting_approval: "patch ready, awaiting approval to open a draft pull request",
  approved: "approved, draft pull request pending",
  rejected: "patch ready, draft pull request rejected",
  expired: "patch ready, approval expired",
  publishing: "approved, opening the draft pull request",
  pr_opened: "draft pull request opened",
  publish_failed: "draft pull request failed",
};

/** A fence longer than any backtick run in the text. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function reasonText(reason: CodeFixReason | null): string {
  return reason === null ? "no reason recorded" : `${REASON_LABELS[reason]} (\`${reason}\`)`;
}

function suggestionLines(attempt: AttemptLike): string[] {
  const s = attempt.suggestion;
  if (s === null) return [];
  const lines = ["", "### Suggestion", ""];
  const where = anchorLine(s);
  if (where !== null) lines.push(where);
  if (s.exception !== null) {
    lines.push(`- Exception: ${inlineCode(s.exception.type, 120)}: ${inlineCode(s.exception.value, 300)}`);
  }
  lines.push(`- Why it stopped: ${reasonText(s.reason)}`);
  if (s.modelRationale !== null) {
    lines.push(`- Model rationale (unverified model text): ${inlineCode(s.modelRationale, 600)}`);
  }
  return lines;
}

function factLines(attempt: AttemptLike): string[] {
  return [
    `- Repository: ${inlineCode(attempt.repo, 201)}, base ${inlineCode(attempt.baseBranch, 200)}` +
      (attempt.baseCommitSha === null ? "" : ` at \`${attempt.baseCommitSha}\``),
    attempt.commitSha === null ? null : `- Release commit: \`${attempt.commitSha}\``,
    exceptionLine(attempt),
    anchorLine(attempt),
    isolationLine(attempt),
    attempt.patchSha256 === null ? null : `- Patch SHA-256: \`${attempt.patchSha256}\``,
    attempt.review === null ? null : `- Reviewer verdict: ${attempt.review.verdict}`,
  ].filter((l): l is string => l !== null);
}

export function renderCodeFixSection(attempt: AttemptLike): string {
  const head = ["## Code fix", ""];
  if (attempt.status === "skipped") {
    return [...head, `Skipped: ${reasonText(attempt.reason)}.`, ""].join("\n");
  }
  if (attempt.status === "running") {
    return [...head, `In progress at stage \`${attempt.stage}\`.`, ""].join("\n");
  }
  if (attempt.status === "gave_up") {
    const lines = [...head, `Gave up at stage \`${attempt.stage}\`: ${reasonText(attempt.reason)}.`];
    if (attempt.violations.length > 0) {
      lines.push("", `Guard violations: ${attempt.violations.map((v) => inlineCode(v, 40)).join(", ")}.`);
    }
    lines.push("", ...factLines(attempt), ...suggestionLines(attempt), "");
    return lines.join("\n");
  }

  let status = `Status: ${STATUS_LABELS[attempt.status]} (mode \`${attempt.mode}\`).`;
  if (attempt.status === "pr_opened" && attempt.pullRequest !== null) {
    const pr = attempt.pullRequest;
    status = `Status: draft pull request opened: [#${pr.number}](${pr.url.replace(/[\s()<>`]/g, "")}) on branch ${inlineCode(pr.branch, 200)}.`;
  } else if (attempt.status === "publish_failed") {
    status = `Status: ${STATUS_LABELS.publish_failed}: ${reasonText(attempt.reason)}.`;
  }
  const lines = [...head, status, "", ...factLines(attempt), "", "### Evidence", "", ...evidenceLines(attempt)];
  const table = fileTable(attempt);
  if (table.length > 0) lines.push("", "### Files", "", ...table);
  if (attempt.patch !== null) {
    const patch = attempt.patch.trimEnd();
    const fence = fenceFor(patch);
    lines.push("", "### Patch", "", `${fence}diff`, patch, fence);
  }
  lines.push("");
  return lines.join("\n");
}
