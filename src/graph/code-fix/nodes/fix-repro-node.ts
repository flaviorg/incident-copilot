// fix_repro (spec 009, decisions 8 and 9; AC-69): writes only the guarded test file, before any source file, and runs
// only that file twice. `classifyReproduction` decides from the reporter's structured results whether it fails for the
// right reason. The failure facts (name, errorName, frames) are kept for the patch author; test output text never is.
import type { CodeFixReason, TestRunSummary } from "../../../contracts/index.ts";
import type { CodeFixLimits } from "../../../domain/code-fix/limits.ts";
import { classifyReproduction } from "../../../domain/code-fix/repro.ts";
import type { ReproClassification } from "../../../domain/code-fix/repro.ts";
import { attemptAborted, signalOf } from "../state.ts";
import type { CodeFixNodeFn, CodeFixSession, CodeFixState } from "../state.ts";
import { summaryOfRun } from "./fix-baseline-node.ts";
import { clipFeedback } from "./fix-author-test-node.ts";

export type FixReproDeps = {
  session: Pick<CodeFixSession, "workspace" | "sandbox">;
  limits: Pick<CodeFixLimits, "testTimeoutSec">;
};

const RUNS = 2;

const REASON: Record<Exclude<ReproClassification, "right_reason">, CodeFixReason> = {
  wrong_reason: "repro_wrong_reason",
  not_failing: "repro_not_failing",
  flaky: "repro_flaky",
};

/** The first failure of the new test, as facts only. */
function observedOf(runs: readonly TestRunSummary[], testPath: string): CodeFixState["observedFailure"] {
  for (const r of runs) {
    const f = r.failures.find((x) => x.file === testPath);
    if (f) return { name: f.name, errorName: f.errorName, frames: f.frames.slice(0, 10).map((x) => ({ file: x.file, line: x.line })) };
  }
  return null;
}

/** Fixed sentences from code facts (the exception type and anchor come from connector data, not from the model). */
function feedbackFor(c: ReproClassification, s: CodeFixState): string[] {
  const type = s.exception?.type ?? "the incident's error";
  const where = s.anchor === null ? "the anchor file" : `${s.anchor.file} near line ${s.anchor.line}`;
  if (c === "not_failing") {
    return [`The new test passed against the current code in both runs; it must fail by reproducing the incident's ${type} raised in ${where}.`];
  }
  if (c === "wrong_reason") {
    return [
      `The new test failed, but not for the incident's reason: it must fail with ${type} raised inside ${where}, by calling the code under test, not by throwing in the test itself.`,
      "A syntax, module, permission, cancellation or timeout failure, or a failure of another test, never counts as a reproduction.",
    ];
  }
  return [];
}

export function createFixReproNode(d: FixReproDeps): CodeFixNodeFn {
  return async (state, config) => {
    const fail = (failure: CodeFixReason, extra: Partial<CodeFixState> = {}): Partial<CodeFixState> => ({ stage: "repro", failure, ...extra });
    if (attemptAborted(config)) return fail("attempt_timeout");
    const { workspace: ws, sandbox } = d.session;
    if (ws === null || sandbox === null) return fail("sandbox_error");
    if (state.testProposal === null || state.exception === null || state.anchor === null) return fail("repro_not_failing");
    const testPath = state.testProposal.test.path;

    try {
      await ws.writeFile(testPath, state.testProposal.test.content);
    } catch {
      return fail(attemptAborted(config) ? "attempt_timeout" : "workspace_failed");
    }

    const runs: TestRunSummary[] = [];
    for (let i = 0; i < RUNS; i++) {
      try {
        runs.push(summaryOfRun(await sandbox.run({ files: [testPath], timeoutSec: d.limits.testTimeoutSec, signal: signalOf(config) })));
      } catch {
        return fail(attemptAborted(config) ? "attempt_timeout" : "sandbox_error", { evidence: { ...state.evidence, reproBefore: runs } });
      }
      if (attemptAborted(config)) return fail("attempt_timeout", { evidence: { ...state.evidence, reproBefore: runs } });
    }

    const evidence = { ...state.evidence, reproBefore: runs };
    const c = classifyReproduction(runs, state.exception, { file: state.anchor.file, line: state.anchor.line }, testPath);
    const observedFailure = observedOf(runs, testPath);
    if (c === "right_reason") return { stage: "repro", failure: null, evidence, observedFailure };
    const feedback = { ...state.feedback, test: clipFeedback(feedbackFor(c, state)) };
    return fail(REASON[c], { evidence, observedFailure, feedback });
  };
}
