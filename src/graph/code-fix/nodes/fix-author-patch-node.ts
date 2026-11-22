// fix_author_patch (spec 009, decisions 8, 17 and 21; AC-70, AC-79, AC-81): the patch author proposes 1..2 search and
// replace edits. It never sees the test: its input carries the exception, the frames, the anchor window, the
// conventions and the observed failure facts (name, errorName, frames), and the prompt schema has no field for the test.
import { fixPatchPrompt } from "../../../prompts/v1/index.ts";
import type { FixPatchInput } from "../../../prompts/v1/index.ts";
import { attemptAborted, fixRunContext } from "../state.ts";
import type { CodeFixNodeFn } from "../state.ts";
import { addUsage, authorFacts, clipFeedback, redactStrings } from "./fix-author-test-node.ts";
import type { FixAuthorDeps } from "./fix-author-test-node.ts";

export type FixAuthorPatchDeps = FixAuthorDeps;

export function createFixAuthorPatchNode(d: FixAuthorPatchDeps): CodeFixNodeFn {
  return async (state, config) => {
    if (attemptAborted(config)) return { stage: "author_patch", failure: "attempt_timeout" };
    const facts = authorFacts(state);
    // Without the observed failure there is nothing reproduced to fix: no call.
    if (facts === null || state.observedFailure === null) return { stage: "author_patch", failure: "author_unavailable" };
    const attempt = state.authorPatchCalls + 1;
    // Built field by field: nothing of `testProposal` can reach this input.
    const input: FixPatchInput = redactStrings({
      repo: facts.repo,
      attempt,
      exception: facts.exception,
      frames: facts.frames,
      anchor: facts.anchor,
      anchorWindow: facts.anchorWindow,
      conventions: facts.conventions,
      failure: {
        name: state.observedFailure.name,
        errorName: state.observedFailure.errorName,
        frames: state.observedFailure.frames.map((f) => ({ file: f.file, line: f.line })),
      },
      feedback: clipFeedback(state.feedback.patch),
    }, d.redact);
    const r = await d.llm.generate(fixPatchPrompt, input, fixRunContext(state, config));
    const counted = { stage: "author_patch" as const, authorPatchCalls: attempt, llm: addUsage(state.llm, r.usage) };
    if (!r.success) return { ...counted, failure: attemptAborted(config) ? "attempt_timeout" : "author_unavailable" };
    return { ...counted, failure: null, patchProposal: structuredClone(r.data) };
  };
}
