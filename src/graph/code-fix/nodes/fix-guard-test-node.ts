// fix_guard_test (spec 009, decisions 8 and 10; AC-68, AC-80): `checkTestFile` runs on the proposed test before
// anything is written or run. It collects every violation at once; the codes go to `violations` and the fixed sentences
// back to the test author as feedback. The node only reads the list of tracked files: no write, no sandbox run.
import type { CodeFixReason } from "../../../contracts/index.ts";
import type { CodeFixLimits } from "../../../domain/code-fix/limits.ts";
import { toSafeRelPath } from "../../../domain/code-fix/paths.ts";
import { checkTestFile } from "../../../domain/code-fix/test-guard.ts";
import { attemptAborted } from "../state.ts";
import type { CodeFixNodeFn, CodeFixSession, CodeFixState } from "../state.ts";
import { clipFeedback } from "./fix-author-test-node.ts";

export type FixGuardTestDeps = {
  session: Pick<CodeFixSession, "workspace">;
  limits: Pick<CodeFixLimits, "maxTestLines">;
};

/** Every tracked file at the base head (the guard checks new paths and relative imports against it). */
const ALL_FILES = ["**"] as const;

export function createFixGuardTestNode(d: FixGuardTestDeps): CodeFixNodeFn {
  return async (state, config) => {
    const fail = (failure: CodeFixReason, extra: Partial<CodeFixState> = {}): Partial<CodeFixState> => ({ stage: "guard_test", failure, ...extra });
    if (attemptAborted(config)) return fail("attempt_timeout");
    const ws = d.session.workspace;
    const repo = state.repository;
    if (ws === null || repo === null || state.anchor === null) return fail("workspace_failed");
    if (state.testProposal === null) return fail("author_unavailable");

    let repoFiles: string[];
    try {
      repoFiles = await ws.listFiles(ALL_FILES);
    } catch {
      return fail(attemptAborted(config) ? "attempt_timeout" : "workspace_failed");
    }
    const proposal = state.testProposal;
    const r = checkTestFile(
      { path: proposal.test.path, content: proposal.test.content, rationale: proposal.rationale },
      { anchorPath: state.anchor.file, sourceGlobs: repo.sourceGlobs, testGlobs: repo.testGlobs, deniedPaths: repo.deniedPaths, repoFiles, limits: d.limits },
    );
    const path = toSafeRelPath(proposal.test.path);
    if (!r.ok || path === null) {
      const violations = r.violations.map((v) => v.code);
      return fail("guard_rejected", {
        violations: violations.length > 0 ? violations : ["path_escape"],
        feedback: { ...state.feedback, test: clipFeedback(r.violations.map((v) => v.message)) },
      });
    }
    // The normalized path is the one repro writes and runs.
    return {
      stage: "guard_test",
      failure: null,
      violations: [],
      testProposal: { ...proposal, test: { path, content: proposal.test.content } },
    };
  };
}
