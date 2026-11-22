// Code fixer reason groups (spec 009, decisions 4, 5 and 16). Pure: no node imports.
import type { CodeFixReason } from "../../contracts/index.ts";

/** Reasons of a `skipped` attempt: decided before any git, LLM or code-host write. Never holds the key. */
export const SKIP_REASONS: readonly CodeFixReason[] = Object.freeze([
  "not_advised", "source_unsupported", "category_not_code", "low_confidence", "service_not_allowlisted",
  "connector_unsupported", "sandbox_unavailable", "daily_cap_reached", "already_attempted", "error_event_unavailable",
  "exception_not_fixable", "not_new_in_release", "no_in_app_frame", "path_not_allowlisted", "path_denied",
  "commit_unresolved", "commit_not_found",
] as const);

/** A give-up with one of these releases the `(repo, errorGroupId)` key, so a later alert may try again (decision 16). */
export const TRANSIENT_REASONS: readonly CodeFixReason[] = Object.freeze([
  "interrupted", "attempt_timeout", "sandbox_error", "baseline_timeout", "workspace_failed", "author_unavailable",
  "reviewer_unavailable", "codehost_error",
] as const);

export function isTransientReason(reason: CodeFixReason | null | undefined): boolean {
  return reason != null && TRANSIENT_REASONS.includes(reason);
}

export function isSkipReason(reason: CodeFixReason | null | undefined): boolean {
  return reason != null && SKIP_REASONS.includes(reason);
}
