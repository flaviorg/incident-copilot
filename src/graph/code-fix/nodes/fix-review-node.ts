// fix_review (spec 009, decisions 12, 17 and 21; AC-72, AC-79, AC-81): the reviewer can only veto. It receives the
// staged diff, the exception, the evidence numbers computed by code and a conventions summary, all redacted and fenced
// as untrusted by the prompt. `reject` gives up with reviewer_rejected; an invalid output or any LLM failure gives up
// with reviewer_unavailable; `approve` only records the verdict and changes no other decision.
import { fixReviewPrompt } from "../../../prompts/v1/index.ts";
import type { FixReviewInput } from "../../../prompts/v1/index.ts";
import { attemptAborted, fixRunContext } from "../state.ts";
import type { CodeFixNodeFn, CodeFixState } from "../state.ts";
import { addUsage, redactStrings } from "./fix-author-test-node.ts";
import type { FixAuthorDeps } from "./fix-author-test-node.ts";

export type FixReviewDeps = FixAuthorDeps;

/** Characters of the conventions summary; whole files stay with the authors. */
const SUMMARY_MAX = 3000;
const SUMMARY_FILE_MAX = 1200;

const passedRun = (r: { outcome: string; failed: number; cancelled: number; total: number }) =>
  r.outcome === "passed" && r.failed === 0 && r.cancelled === 0 && r.total > 0;

/** Numbers only, computed by code from the stored test summaries. */
export function evidenceNumbers(s: CodeFixState): FixReviewInput["evidence"] {
  const suite = s.evidence.suiteAfter;
  return {
    baselineTotal: s.evidence.baseline?.total ?? 0,
    reproFailedRuns: s.evidence.reproBefore.filter((r) => r.failed > 0).length,
    fixPassedRuns: s.evidence.fixAfter.filter(passedRun).length,
    suiteTotal: suite?.total ?? 0,
    suitePassed: suite?.passed ?? 0,
    suiteFailed: suite?.failed ?? 0,
  };
}

/** package.json data, AGENTS.md and CONTRIBUTING.md (clipped), and the names of the nearest tests. */
export function conventionsSummary(s: CodeFixState): string {
  const files = s.conventions?.files ?? [];
  const parts: string[] = [];
  const tests = files.filter((f) => f.kind === "nearest_test").map((f) => f.path);
  if (tests.length > 0) parts.push(`Nearest existing tests: ${tests.join(", ")}`);
  for (const f of files) {
    if (f.kind !== "package_json" && f.kind !== "agents" && f.kind !== "contributing") continue;
    const text = f.text.length <= SUMMARY_FILE_MAX ? f.text : f.text.slice(0, SUMMARY_FILE_MAX - 1) + "…";
    parts.push(`${f.path}:\n${text}`);
  }
  const out = parts.length === 0 ? "(none)" : parts.join("\n\n");
  return out.length <= SUMMARY_MAX ? out : out.slice(0, SUMMARY_MAX - 1) + "…";
}

export function createFixReviewNode(d: FixReviewDeps): CodeFixNodeFn {
  return async (state, config) => {
    if (attemptAborted(config)) return { stage: "review", failure: "attempt_timeout" };
    if (state.repository === null || state.exception === null || state.patch === null) return { stage: "review", failure: "reviewer_unavailable" };
    const input: FixReviewInput = redactStrings({
      repo: state.repository.repo,
      exception: { type: state.exception.type, value: state.exception.value },
      diff: state.patch,
      evidence: evidenceNumbers(state),
      conventionsSummary: conventionsSummary(state),
    }, d.redact);
    const r = await d.llm.generate(fixReviewPrompt, input, fixRunContext(state, config));
    const llm = addUsage(state.llm, r.usage);
    if (!r.success) return { stage: "review", failure: attemptAborted(config) ? "attempt_timeout" : "reviewer_unavailable", llm };
    const review = { verdict: r.data.verdict, concerns: [...r.data.concerns] };
    return { stage: "review", failure: review.verdict === "approve" ? null : "reviewer_rejected", review, llm };
  };
}
