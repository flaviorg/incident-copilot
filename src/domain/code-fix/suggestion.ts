// Suggestion attached to a give-up after locate (spec 009, AC-69). Pure and built from facts: the anchor frame and the
// exception come from connector data; the model's rationale is kept only as clipped, unverified text.
// The caller applies `redactSecrets` before the suggestion is stored or leaves the process.
import type { CodeFixAttempt, CodeFixReason, CodeFixSuggestion } from "../../contracts/index.ts";
import { sanitizeText } from "../ingest/sanitize.ts";

export function buildSuggestion(
  attempt: Pick<CodeFixAttempt, "anchor" | "exception">,
  reason: CodeFixReason,
  modelRationale: string | null,
): CodeFixSuggestion {
  const rationale = modelRationale === null ? "" : sanitizeText(modelRationale, 600);
  return {
    anchor: attempt.anchor === null ? null : { ...attempt.anchor },
    exception: attempt.exception === null
      ? null
      : { type: sanitizeText(attempt.exception.type, 120), value: sanitizeText(attempt.exception.value, 300) },
    reason,
    modelRationale: rationale === "" ? null : rationale,
  };
}
