// Code fixer contracts (spec 009). Browser-safe: only imports zod and sibling contracts.
// No model output schema here has a tier, approval, command, repository or publish field.
import * as z from "zod";
import { ConnectorIdSchema } from "./ingest.ts";
import { StackFrameSchema } from "./live-telemetry.ts";

const sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const ExceptionSchema = z.object({ type: z.string().max(120), value: z.string().max(300) });

export const CodeFixModeSchema = z.enum(["shadow", "draft_pr"]);
export const CodeFixIsolationSchema = z.enum(["isolated", "best_effort"]);
export const CodeFixStatusSchema = z.enum([
  "skipped", "running", "gave_up", "patch_ready", "awaiting_approval", "approved", "rejected", "expired",
  "publishing", "pr_opened", "publish_failed",
]);
export const CodeFixStageSchema = z.enum([
  "eligibility", "locate", "workspace", "baseline", "author_test", "guard_test", "repro",
  "author_patch", "guard_patch", "verify", "review", "finalize", "publish",
]);
export const CodeFixReasonSchema = z.enum([
  // skipped (no git, no LLM)
  "not_advised", "source_unsupported", "category_not_code", "low_confidence", "service_not_allowlisted",
  "connector_unsupported", "sandbox_unavailable", "daily_cap_reached", "already_attempted", "error_event_unavailable",
  "exception_not_fixable", "not_new_in_release", "no_in_app_frame", "path_not_allowlisted", "path_denied",
  "commit_unresolved", "commit_not_found",
  // gave_up
  "workspace_failed", "file_changed_since_release", "line_out_of_range", "file_not_regular", "baseline_not_green",
  "baseline_timeout", "sandbox_error", "author_unavailable", "budget_exhausted", "attempt_timeout", "guard_rejected",
  "repro_not_failing", "repro_wrong_reason", "repro_flaky", "edit_not_applicable", "fix_not_passing", "fix_flaky",
  "suite_regressed", "test_count_dropped", "unexpected_file", "patch_too_large", "patch_contains_secret",
  "reviewer_rejected", "reviewer_unavailable", "catalog_refused", "interrupted",
  // publish_failed
  "patch_mismatch", "base_unprotected", "stale_base", "ref_conflict", "codehost_error",
]);

export const TestFailureSchema = z.object({
  name: z.string().max(200),
  file: z.string().max(300),
  errorName: z.string().max(120),
  message: z.string().max(200),
  frames: z.array(z.object({ file: z.string().max(300), line: z.number().int().positive() })).max(10),
});

export const TestRunSummarySchema = z.object({
  outcome: z.enum(["passed", "failed", "error", "timeout"]),
  exitCode: z.number().int().nullable(),
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  todo: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  failures: z.array(TestFailureSchema).max(5),
});

export const CodeFixFileSchema = z.object({
  path: z.string().max(300),
  role: z.enum(["test", "source"]),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  afterSha256: sha256,
});

/** Built from facts for a give-up after locate. */
export const CodeFixSuggestionSchema = z.object({
  anchor: StackFrameSchema.nullable(),
  exception: ExceptionSchema.nullable(),
  reason: CodeFixReasonSchema,
  modelRationale: z.string().max(600).nullable(), // labeled as unverified model text
});

export const CodeFixAttemptSchema = z.object({
  id: z.string().regex(/^fix_[a-z0-9]{8,40}$/),
  incidentId: z.string(),
  repo: z.string().max(201),
  service: z.string().max(120),
  connectorId: ConnectorIdSchema,
  errorGroupId: z.string().max(40),
  mode: CodeFixModeSchema,
  isolation: CodeFixIsolationSchema,
  status: CodeFixStatusSchema,
  stage: CodeFixStageSchema,
  reason: CodeFixReasonSchema.nullable(),
  violations: z.array(z.string().max(40)).max(40), // guard codes only
  release: z.string().max(120).nullable(),
  commitSha: sha40.nullable(),
  baseBranch: z.string().max(200),
  baseCommitSha: sha40.nullable(),
  exception: ExceptionSchema.nullable(),
  anchor: StackFrameSchema.nullable(),
  files: z.array(CodeFixFileSchema).max(3),
  patch: z.string().max(20_000).nullable(),
  patchSha256: sha256.nullable(),
  contents: z.array(z.object({ path: z.string().max(300), text: z.string().max(262_144) })).max(3), // post-images; never in a view
  evidence: z.object({
    baseline: TestRunSummarySchema.nullable(),
    reproBefore: z.array(TestRunSummarySchema).max(2),
    fixAfter: z.array(TestRunSummarySchema).max(2),
    suiteAfter: TestRunSummarySchema.nullable(),
  }),
  review: z.object({ verdict: z.enum(["approve", "reject"]), concerns: z.array(z.string().max(200)).max(5) }).nullable(),
  suggestion: CodeFixSuggestionSchema.nullable(),
  approvalId: z.string().nullable(),
  commit: z.object({ sha: sha40, tree: sha40 }).nullable(),
  pullRequest: z.object({ number: z.number().int().positive(), url: z.string().max(2000), branch: z.string().max(200) }).nullable(),
  llm: z.object({
    calls: z.number().int().nonnegative(),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
  }),
  startedAt: z.iso.datetime(),
  patchReadyAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  version: z.number().int().nonnegative(),
});

/** What leaves the process: no post-images (redacted before it leaves). */
export const CodeFixAttemptViewSchema = CodeFixAttemptSchema.omit({ contents: true });

// ---------- model output (proposals only) ----------

export const FixTestProposalSchema = z.object({
  test: z.object({ path: z.string().max(200), content: z.string().max(6000) }),
  rationale: z.string().max(600),
});

export const FixPatchProposalSchema = z.object({
  edits: z.array(z.object({ path: z.string().max(200), search: z.string().min(1).max(2000), replace: z.string().max(2000) })).min(1).max(2),
  rationale: z.string().max(600),
});

export const FixReviewSchema = z.object({
  verdict: z.enum(["approve", "reject"]),
  concerns: z.array(z.string().max(200)).max(5),
});
