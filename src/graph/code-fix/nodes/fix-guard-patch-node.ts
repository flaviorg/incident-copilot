// fix_guard_patch (spec 009, decisions 8 and 10; AC-70, AC-80): `checkPatch` runs on the proposed edits before any
// source file is written. It collects every violation at once (codes in `violations`, fixed sentences back to the patch
// author). When the guard passes, every `search` must still occur exactly once in the work tree (`edit_not_applicable`).
// The node only reads work-tree files at safe, non-denied paths: no write, no sandbox run.
import type { CodeFixReason } from "../../../contracts/index.ts";
import { applyEditsToFiles } from "../../../domain/code-fix/edits.ts";
import type { CodeFixLimits } from "../../../domain/code-fix/limits.ts";
import { checkPatch, inAppRepoPaths } from "../../../domain/code-fix/patch-guard.ts";
import { isDenied, toSafeRelPath } from "../../../domain/code-fix/paths.ts";
import type { Workspace } from "../../../domain/code-fix/ports.ts";
import { attemptAborted } from "../state.ts";
import type { CodeFixNodeFn, CodeFixSession, CodeFixState } from "../state.ts";
import { clipFeedback } from "./fix-author-test-node.ts";

export type FixGuardPatchDeps = {
  session: Pick<CodeFixSession, "workspace">;
  limits: Pick<CodeFixLimits, "maxFiles" | "maxSourceLines" | "maxTotalLines" | "maxEdits">;
};

/** Work-tree text of the edited files whose path is safe and not denied; anything else is never read. */
export async function readEditTargets(
  ws: Workspace,
  edits: readonly { path: string }[],
  deniedPaths: readonly string[],
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const e of edits) {
    const p = toSafeRelPath(e.path);
    if (p === null || p !== e.path || isDenied(p, deniedPaths) || Object.hasOwn(out, p)) continue;
    out[p] = await ws.readFile(p);
  }
  return out;
}

/** A fixed sentence for an edit whose search does not occur exactly once (edit index and match count only). */
export function notApplicableSentence(index: number, matches: number): string {
  return `Edit ${index + 1}: its search text occurs ${matches} times in the file; copy it exactly from the shown file so it occurs exactly once.`;
}

export function createFixGuardPatchNode(d: FixGuardPatchDeps): CodeFixNodeFn {
  return async (state, config) => {
    const fail = (failure: CodeFixReason, extra: Partial<CodeFixState> = {}): Partial<CodeFixState> => ({ stage: "guard_patch", failure, ...extra });
    if (attemptAborted(config)) return fail("attempt_timeout");
    const ws = d.session.workspace;
    const repo = state.repository;
    if (ws === null || repo === null || state.anchor === null) return fail("workspace_failed");
    if (state.patchProposal === null || state.testProposal === null) return fail("author_unavailable");
    const edits = state.patchProposal.edits;

    let originals: Record<string, string | null>;
    try {
      originals = await readEditTargets(ws, edits, repo.deniedPaths);
    } catch {
      return fail(attemptAborted(config) ? "attempt_timeout" : "workspace_failed");
    }

    const r = checkPatch(edits, {
      test: { path: state.testProposal.test.path, content: state.testProposal.test.content },
      anchor: { path: state.anchor.file, line: state.anchor.line },
      inAppPaths: inAppRepoPaths(state.frames, repo.pathPrefixes),
      sourceGlobs: repo.sourceGlobs,
      testGlobs: repo.testGlobs,
      deniedPaths: repo.deniedPaths,
      originals,
      limits: d.limits,
      rationale: state.patchProposal.rationale,
    });
    const applied = applyEditsToFiles(originals, edits);
    const applySentence = applied.ok ? [] : [notApplicableSentence(applied.index, applied.matches)];

    if (!r.ok) {
      return fail("guard_rejected", {
        violations: r.violations.map((v) => v.code),
        feedback: { ...state.feedback, patch: clipFeedback([...r.violations.map((v) => v.message), ...applySentence]) },
      });
    }
    if (!applied.ok) {
      return fail("edit_not_applicable", { violations: [], feedback: { ...state.feedback, patch: clipFeedback(applySentence) } });
    }
    return { stage: "guard_patch", failure: null, violations: [] };
  };
}
