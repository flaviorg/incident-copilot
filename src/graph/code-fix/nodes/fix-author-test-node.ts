// fix_author_test (spec 009, decisions 8, 17, 18 and 21; AC-68, AC-79, AC-81): the test author proposes one new test
// file. Code decides everything after it: the guard, the reproduction and the retries. Every call counts against the
// attempt's budget, failed ones included, and an LLM failure is a value (`author_unavailable`), never an exception.
// Every text sent to the model goes through the injected redaction; the prompt fences it as untrusted.
import type { LlmProvider, LlmUsage } from "../../../llm/provider.ts";
import { fixTestPrompt } from "../../../prompts/v1/index.ts";
import type { FixTestInput } from "../../../prompts/v1/index.ts";
import { attemptAborted, fixRunContext } from "../state.ts";
import type { CodeFixNodeFn, CodeFixState } from "../state.ts";

export type FixAuthorDeps = {
  /** The recording provider (decision 18); the only LLM handle the fixer has. */
  llm: LlmProvider;
  /** `redactSecrets` bound to the known secrets. */
  redact: (text: string) => string;
};

export type FixAuthorTestDeps = FixAuthorDeps;

/** Feedback limits of the state schema: 40 sentences of at most 400 characters per author. */
const FEEDBACK_MAX = 40;
const SENTENCE_MAX = 400;

export function clipFeedback(sentences: readonly string[]): string[] {
  return sentences.slice(0, FEEDBACK_MAX).map((s) => (s.length <= SENTENCE_MAX ? s : s.slice(0, SENTENCE_MAX - 1) + "…"));
}

/** One more logical call, plus the usage the provider reported (failed calls may report it too). */
export function addUsage(llm: CodeFixState["llm"], usage: LlmUsage | undefined): CodeFixState["llm"] {
  return {
    calls: llm.calls + 1,
    promptTokens: llm.promptTokens + Math.max(0, Math.floor(usage?.promptTokens ?? 0)),
    completionTokens: llm.completionTokens + Math.max(0, Math.floor(usage?.completionTokens ?? 0)),
  };
}

/** Applies `redact` to every string of a plain value (objects and arrays), without mutating it. */
export function redactStrings<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactStrings(v, redact)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactStrings(v, redact)])) as T;
  }
  return value;
}

/** The facts both authors receive (from connector data and the read-only conventions), or null when one is missing. */
export function authorFacts(s: CodeFixState): Omit<FixTestInput, "attempt" | "observedFailure" | "feedback"> | null {
  if (s.repository === null || s.exception === null || s.anchor === null) return null;
  const files = s.conventions?.files ?? [];
  const window = files.find((f) => f.kind === "anchor_window" && f.path === s.anchor!.file);
  return {
    repo: s.repository.repo,
    exception: { type: s.exception.type, value: s.exception.value },
    frames: s.frames.map((f) => ({ ...f })),
    anchor: { ...s.anchor },
    anchorWindow: window
      ? { path: window.path, startLine: window.startLine ?? 1, text: window.text }
      : { path: s.anchor.file, startLine: 1, text: "" },
    conventions: files.filter((f) => f !== window).map((f) => ({ path: f.path, text: f.text })),
  };
}

/**
 * After repro wrote a test, the work tree already holds that file and the Workspace port cannot delete it, so a retry
 * must reuse the path (it is then overwritten). A different path leaves the old file behind, and fix_verify gives up
 * with `unexpected_file`: fail closed. The path was normalized by fix_guard_test, so it is a safe repo path.
 */
function samePathSentence(s: CodeFixState): string[] {
  if (s.testProposal === null || s.evidence.reproBefore.length === 0) return [];
  return [`Write the new test at the same path as before, ${s.testProposal.test.path}, replacing the previous test file.`];
}

export function createFixAuthorTestNode(d: FixAuthorTestDeps): CodeFixNodeFn {
  return async (state, config) => {
    if (attemptAborted(config)) return { stage: "author_test", failure: "attempt_timeout" };
    const facts = authorFacts(state);
    if (facts === null) return { stage: "author_test", failure: "author_unavailable" };
    const attempt = state.authorTestCalls + 1;
    const input: FixTestInput = redactStrings({
      ...facts,
      attempt,
      ...(state.observedFailure === null ? {} : { observedFailure: structuredClone(state.observedFailure) }),
      feedback: clipFeedback([...state.feedback.test, ...samePathSentence(state)]),
    }, d.redact);
    const r = await d.llm.generate(fixTestPrompt, input, fixRunContext(state, config));
    const counted = { stage: "author_test" as const, authorTestCalls: attempt, llm: addUsage(state.llm, r.usage) };
    if (!r.success) return { ...counted, failure: attemptAborted(config) ? "attempt_timeout" : "author_unavailable" };
    return { ...counted, failure: null, testProposal: structuredClone(r.data) };
  };
}
