// fix_baseline (spec 009, decision 8; AC-67): the full suite runs before any LLM call and must pass with at least one
// test, no failure and no cancelled test. The stored evidence is the summary only; the untrusted output tail is dropped.
import type { CodeFixReason, TestRunSummary } from "../../../contracts/index.ts";
import type { CodeFixLimits } from "../../../domain/code-fix/limits.ts";
import type { SandboxRunResult } from "../../../domain/code-fix/ports.ts";
import { attemptAborted, signalOf } from "../state.ts";
import type { CodeFixNodeFn, CodeFixSession, CodeFixState } from "../state.ts";

export type FixBaselineDeps = {
  session: Pick<CodeFixSession, "sandbox">;
  limits: Pick<CodeFixLimits, "testTimeoutSec">;
};

/** The summary of a run without the output tail (evidence never stores test output text). */
export function summaryOfRun(r: SandboxRunResult): TestRunSummary {
  return {
    outcome: r.outcome, exitCode: r.exitCode, total: r.total, passed: r.passed, failed: r.failed, skipped: r.skipped, todo: r.todo,
    cancelled: r.cancelled, durationMs: r.durationMs, failures: r.failures.map((f) => ({ ...f, frames: f.frames.map((x) => ({ ...x })) })),
  };
}

/**
 * Green: passed, at least one test, nothing failed or cancelled. The runner reports a suite that ran and exited 0
 * without a single test as `error` (decision 7); for the baseline that is a red suite (AC-67), a permanent
 * `baseline_not_green`, not a sandbox fault. A spawn failure (no exit code) or a report that contradicts its exit code
 * stays `sandbox_error`.
 */
export function baselineFailure(r: TestRunSummary): CodeFixReason | null {
  if (r.outcome === "timeout") return "baseline_timeout";
  if (r.outcome === "error") return r.exitCode === 0 && r.total === 0 ? "baseline_not_green" : "sandbox_error";
  if (r.outcome !== "passed" || r.total <= 0 || r.failed > 0 || r.cancelled > 0) return "baseline_not_green";
  return null;
}

export function createFixBaselineNode(d: FixBaselineDeps): CodeFixNodeFn {
  return async (state, config) => {
    const fail = (failure: CodeFixReason, extra: Partial<CodeFixState> = {}): Partial<CodeFixState> => ({ stage: "baseline", failure, ...extra });
    if (attemptAborted(config)) return fail("attempt_timeout");
    const sandbox = d.session.sandbox;
    if (state.repository === null || sandbox === null) return fail("sandbox_error");
    let run: SandboxRunResult;
    try {
      run = await sandbox.run({ files: state.repository.testFiles, timeoutSec: d.limits.testTimeoutSec, signal: signalOf(config) });
    } catch {
      return fail(attemptAborted(config) ? "attempt_timeout" : "sandbox_error");
    }
    const summary = summaryOfRun(run);
    const evidence = { ...state.evidence, baseline: summary };
    const failure = baselineFailure(summary);
    if (failure !== null) return fail(attemptAborted(config) && failure !== "baseline_not_green" ? "attempt_timeout" : failure, { evidence });
    return { stage: "baseline", failure: null, evidence };
  };
}
