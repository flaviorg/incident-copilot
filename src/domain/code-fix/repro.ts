// Reproduction and verification checks (spec 009, decisions 9 and 11; AC-69, AC-71). Pure: decided by code from the
// reporter's structured results, never from model text or test output text.
import type { TestFailure, TestRunSummary } from "../../contracts/index.ts";

export type ReproClassification = "right_reason" | "wrong_reason" | "not_failing" | "flaky";
export type VerifyOutcome = "ok" | "fix_not_passing" | "fix_flaky" | "suite_regressed" | "test_count_dropped";

/** Failures that are never "the right reason": they prove the test did not run the buggy code. */
const NEVER_RIGHT = ["SyntaxError", "ERR_MODULE_NOT_FOUND", "ERR_ACCESS_DENIED"] as const;
/** Lines around the anchor line that count as the anchor. */
export const ANCHOR_LINE_WINDOW = 10;
/** Characters of the normalized incident message used as its prefix; shorter prefixes are too weak to match on. */
const MESSAGE_PREFIX_CHARS = 32;
const MIN_PREFIX_CHARS = 8;

/**
 * Signature of one failure: test name, test file, error name and frames (`file:line`). The message is left out
 * because it can carry run-dependent values.
 */
export function sameSignature(a: TestFailure, b: TestFailure): boolean {
  if (a.name !== b.name || a.file !== b.file || a.errorName !== b.errorName) return false;
  if (a.frames.length !== b.frames.length) return false;
  return a.frames.every((f, i) => f.file === b.frames[i]!.file && f.line === b.frames[i]!.line);
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function messagePrefix(value: string): string | null {
  const p = normalize(value).slice(0, MESSAGE_PREFIX_CHARS).trim();
  return p.length >= MIN_PREFIX_CHARS ? p : null;
}

function isNeverRight(f: TestFailure): boolean {
  return NEVER_RIGHT.some((code) => f.errorName === code || f.errorName.includes(code) || f.message.includes(code));
}

/** Reporter frames are innermost first (V8 stack order). The innermost frame not in the test file must be the anchor. */
function anchoredFrame(f: TestFailure, anchor: { file: string; line: number }, testPath: string): boolean {
  const inner = f.frames.find((fr) => fr.file !== testPath);
  return inner !== undefined && inner.file === anchor.file && Math.abs(inner.line - anchor.line) <= ANCHOR_LINE_WINDOW;
}

function rightReason(
  f: TestFailure, exception: { type: string; value: string }, anchor: { file: string; line: number }, testPath: string,
): boolean {
  if (isNeverRight(f)) return false;
  const prefix = messagePrefix(exception.value);
  const matches = f.errorName === exception.type || (prefix !== null && normalize(f.message).includes(prefix));
  return matches && anchoredFrame(f, anchor, testPath);
}

type RunView = { kind: "pass" } | { kind: "bad" } | { kind: "fail"; failures: TestFailure[] };

function viewRun(run: TestRunSummary, testPath: string): RunView {
  if (run.outcome === "timeout" || run.outcome === "error" || run.cancelled > 0) return { kind: "bad" };
  const ours = run.failures.filter((f) => f.file === testPath);
  if (ours.length === 0) return { kind: "pass" };
  if (ours.length !== run.failures.length) return { kind: "bad" }; // only the new test may fail
  return { kind: "fail", failures: ours };
}

/**
 * Classifies the two runs of the new test file before any source edit. Both runs must fail the new test (and only the
 * new test) with the same signature, by the incident's exception type or message prefix, never by a syntax, module,
 * permission, cancellation or timeout error, with the innermost non-test frame in the anchor file within
 * ±{@link ANCHOR_LINE_WINDOW} lines of the anchor line.
 */
export function classifyReproduction(
  runs: readonly TestRunSummary[],
  exception: { type: string; value: string },
  anchor: { file: string; line: number },
  testPath: string,
): ReproClassification {
  if (runs.length === 0) return "not_failing";
  const views = runs.map((r) => viewRun(r, testPath));
  if (views.some((v) => v.kind === "bad")) return "wrong_reason";
  const fails = views.filter((v): v is Extract<RunView, { kind: "fail" }> => v.kind === "fail");
  if (fails.length === 0) return "not_failing";
  if (fails.length !== views.length || views.length < 2) return "flaky";
  const first = fails[0]!.failures;
  for (const v of fails.slice(1)) {
    if (v.failures.length !== first.length || !v.failures.every((f, i) => sameSignature(f, first[i]!))) return "flaky";
  }
  return first.every((f) => rightReason(f, exception, anchor, testPath)) ? "right_reason" : "wrong_reason";
}

function sameCounts(a: TestRunSummary, b: TestRunSummary): boolean {
  return a.total === b.total && a.passed === b.passed && a.failed === b.failed && a.skipped === b.skipped
    && a.todo === b.todo && a.cancelled === b.cancelled;
}

function runPassed(r: TestRunSummary): boolean {
  return r.outcome === "passed" && r.failed === 0 && r.cancelled === 0 && r.total > 0;
}

/**
 * After the source edits: the new test must pass in both runs, then the full suite must pass with no failure, with
 * `total === baseline.total + newTests` and no more skipped or todo tests than the baseline.
 */
export function verifyOutcome(
  baseline: TestRunSummary,
  fixRuns: readonly TestRunSummary[],
  suiteAfter: TestRunSummary | null,
  newTests: number,
): VerifyOutcome {
  const passedRuns = fixRuns.filter(runPassed).length;
  if (passedRuns === 0) return "fix_not_passing";
  if (passedRuns < 2 || passedRuns !== fixRuns.length) return "fix_flaky";
  // Defense in depth against a report forged in-process: both passing runs must report the same counts.
  if (fixRuns.some((r) => !sameCounts(r, fixRuns[0]!))) return "fix_flaky";
  if (suiteAfter === null || !runPassed(suiteAfter)) return "suite_regressed";
  if (suiteAfter.total !== baseline.total + newTests) return "test_count_dropped";
  if (suiteAfter.skipped > baseline.skipped || suiteAfter.todo > baseline.todo) return "test_count_dropped";
  return "ok";
}
