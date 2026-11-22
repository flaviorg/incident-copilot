// fix_verify (spec 009, decisions 8 and 11; AC-71, AC-79): applies the guarded edits to the work tree, runs the new
// test twice and then the full suite, and judges the runs with `verifyOutcome`. The diff comes from the staged work
// tree, never from model text: `checkDiff` re-runs the size, path and file-kind rules on it, any other changed path is
// `unexpected_file`, and a patch that redaction would change is `patch_contains_secret`. The artifact is the patch plus
// the staged post-image of every changed file and its SHA-256 (from the injected `sha256`: the graph cannot use
// node:crypto).
// When it fails after writing, the source files are restored, so a patch retry starts from the base head's text.
import type { CodeFixFile, CodeFixReason, TestRunSummary } from "../../../contracts/index.ts";
import { applyEditsToFiles } from "../../../domain/code-fix/edits.ts";
import type { CodeFixLimits } from "../../../domain/code-fix/limits.ts";
import { checkDiff } from "../../../domain/code-fix/patch-guard.ts";
import { matchesAnyGlob } from "../../../domain/code-fix/paths.ts";
import type { StagedDiff, Workspace } from "../../../domain/code-fix/ports.ts";
import { verifyOutcome } from "../../../domain/code-fix/repro.ts";
import { attemptAborted, signalOf } from "../state.ts";
import type { CodeFixNodeFn, CodeFixSession, CodeFixState } from "../state.ts";
import { summaryOfRun } from "./fix-baseline-node.ts";
import { clipFeedback } from "./fix-author-test-node.ts";
import { notApplicableSentence, readEditTargets } from "./fix-guard-patch-node.ts";

export type FixVerifyDeps = {
  session: Pick<CodeFixSession, "workspace" | "sandbox">;
  limits: Pick<CodeFixLimits, "testTimeoutSec" | "maxFiles" | "maxSourceLines" | "maxTotalLines">;
  /** Hex SHA-256 of the UTF-8 text (node:crypto in the app layer). */
  sha256: (text: string) => string;
  /** `redactSecrets` bound to the known secrets. */
  redact: (text: string) => string;
};

/** Limits of the stored artifact (CodeFixAttemptSchema): the patch text and each post-image. */
export const MAX_PATCH_CHARS = 20_000;
export const MAX_POST_IMAGE_BYTES = 256 * 1024;

const RUNS = 2;
const encoder = new TextEncoder();

async function restore(ws: Workspace, files: readonly { path: string; before: string }[]): Promise<void> {
  for (const f of files) {
    try {
      await ws.writeFile(f.path, f.before);
    } catch {
      // best effort: the attempt gives up anyway, and the workspace is disposed by the service
    }
  }
}

function passed(r: TestRunSummary): boolean {
  return r.outcome === "passed" && r.failed === 0 && r.cancelled === 0 && r.total > 0;
}

export function createFixVerifyNode(d: FixVerifyDeps): CodeFixNodeFn {
  return async (state, config) => {
    const fail = (failure: CodeFixReason, extra: Partial<CodeFixState> = {}): Partial<CodeFixState> => ({ stage: "verify", failure, ...extra });
    const timedOut = (other: CodeFixReason): CodeFixReason => (attemptAborted(config) ? "attempt_timeout" : other);
    if (attemptAborted(config)) return fail("attempt_timeout");
    const { workspace: ws, sandbox } = d.session;
    const repo = state.repository;
    const baseline = state.evidence.baseline;
    if (ws === null || sandbox === null) return fail("sandbox_error");
    if (repo === null || baseline === null) return fail("sandbox_error");
    if (state.patchProposal === null || state.testProposal === null) return fail("author_unavailable");
    const testPath = state.testProposal.test.path;
    const edits = state.patchProposal.edits;

    // 1. Apply the edits to the current work-tree text (each search exactly once).
    let originals: Record<string, string | null>;
    try {
      originals = await readEditTargets(ws, edits, repo.deniedPaths);
    } catch {
      return fail(timedOut("workspace_failed"));
    }
    const applied = applyEditsToFiles(originals, edits);
    if (!applied.ok) {
      return fail("edit_not_applicable", { feedback: { ...state.feedback, patch: clipFeedback([notApplicableSentence(applied.index, applied.matches)]) } });
    }
    const written: { path: string; before: string }[] = [];
    const undo = async (failure: CodeFixReason, extra: Partial<CodeFixState> = {}) => {
      await restore(ws, written);
      return fail(failure, extra);
    };
    try {
      for (const f of applied.files) {
        written.push({ path: f.path, before: f.before });
        await ws.writeFile(f.path, f.after);
      }
    } catch {
      return undo(timedOut("workspace_failed"));
    }
    const editedPaths = applied.files.map((f) => f.path);

    // 2. The new test twice, then (only when both passed) the full suite.
    const run = (files: readonly string[]) => sandbox.run({ files, timeoutSec: d.limits.testTimeoutSec, signal: signalOf(config) });
    const fixAfter: TestRunSummary[] = [];
    let suiteAfter: TestRunSummary | null = null;
    const evidence = () => ({ ...state.evidence, fixAfter: [...fixAfter], suiteAfter });
    try {
      for (let i = 0; i < RUNS; i++) {
        fixAfter.push(summaryOfRun(await run([testPath])));
        if (attemptAborted(config)) return undo("attempt_timeout", { evidence: evidence() });
      }
      if (fixAfter.every(passed)) {
        const suiteFiles = matchesAnyGlob(testPath, repo.testFiles) ? repo.testFiles : [...repo.testFiles, testPath];
        suiteAfter = summaryOfRun(await run(suiteFiles));
        if (attemptAborted(config)) return undo("attempt_timeout", { evidence: evidence() });
      }
    } catch {
      return undo(timedOut("sandbox_error"), { evidence: evidence() });
    }
    const newTests = fixAfter[0]?.total ?? 0;
    const outcome = verifyOutcome(baseline, fixAfter, suiteAfter, newTests);
    if (outcome !== "ok") {
      const feedback = outcome === "fix_not_passing"
        ? { ...state.feedback, patch: clipFeedback([`After the edits the new test still failed in ${fixAfter.filter((r) => !passed(r)).length} of ${fixAfter.length} runs; the change must fix the cause of the error.`]) }
        : state.feedback;
      return undo(outcome, { evidence: evidence(), feedback });
    }

    // 3. The real diff from the staged work tree.
    let diff: StagedDiff;
    try {
      diff = await ws.stagedDiff();
    } catch {
      return fail(timedOut("workspace_failed"), { evidence: evidence() });
    }
    const guard = checkDiff(diff.changes, {
      testPath,
      editedPaths,
      sourceGlobs: repo.sourceGlobs,
      testGlobs: repo.testGlobs,
      deniedPaths: repo.deniedPaths,
      limits: d.limits,
    });
    if (!guard.ok) {
      const violations = guard.violations.map((v) => v.code);
      return fail(violations.includes("unexpected_file") ? "unexpected_file" : "guard_rejected", { evidence: evidence(), violations });
    }
    if (diff.patch.length > MAX_PATCH_CHARS) return fail("patch_too_large", { evidence: evidence() });

    // 4. Post-images of every changed file, read from the index: the exact bytes the patch and numstat describe (the
    // work tree can differ when the repository's .gitattributes converts line endings or expands `ident`).
    const contents: { path: string; text: string }[] = [];
    for (const c of diff.changes) {
      let text: string | null;
      try {
        text = await ws.readStaged(c.path);
      } catch {
        return fail(timedOut("workspace_failed"), { evidence: evidence() });
      }
      if (text === null) return fail("unexpected_file", { evidence: evidence(), violations: ["unexpected_file"] });
      if (encoder.encode(text).length > MAX_POST_IMAGE_BYTES) return fail("patch_too_large", { evidence: evidence() });
      contents.push({ path: c.path, text });
    }
    if (d.redact(diff.patch) !== diff.patch || contents.some((c) => d.redact(c.text) !== c.text)) {
      return fail("patch_contains_secret", { evidence: evidence() });
    }
    const files: CodeFixFile[] = diff.changes.map((c, i) => ({
      path: c.path,
      role: c.path === testPath ? "test" : "source",
      added: c.added,
      removed: c.removed,
      afterSha256: d.sha256(contents[i]!.text),
    }));
    return { stage: "verify", failure: null, violations: [], evidence: evidence(), patch: diff.patch, files, contents };
  };
}
