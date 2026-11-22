// fix_workspace (spec 009, decision 6; AC-62, AC-64): a hardened shallow fetch of the allowlisted repository at the
// confirmed commit and the base branch, then the anchor checks and the read-only conventions. The clone URL and the token
// come from the deps (allowlist and config), never from the state or a model. The workspace and the sandbox built for it
// go into the session, so the service disposes the workspace in its `finally` block whatever happens next.
import type { CodeFixReason } from "../../../contracts/index.ts";
import type { GitWorkspacePort, SandboxRunner, Workspace } from "../../../domain/code-fix/ports.ts";
import type { AnchorCheckResult } from "../../../infra/code-fix/git-workspace.ts";
import type { Conventions, ReadConventionsInput } from "../../../infra/code-fix/conventions.ts";
import { attemptAborted, signalOf } from "../state.ts";
import type { CodeFixNodeFn, CodeFixSession, CodeFixState } from "../state.ts";

export type FixWorkspaceDeps = {
  git: GitWorkspacePort;
  session: CodeFixSession;
  /** Builds the sandbox runner for this attempt's directory. */
  sandboxFor: (ws: Workspace) => SandboxRunner;
  /** https clone URL of an allowlisted `owner/name`. */
  cloneUrl: (repo: string) => string;
  /** `codeFix.github.token`; reaches git only through the askpass script. */
  token: string | null;
  /** `anchorChecks` of src/infra/code-fix/git-workspace.ts. */
  checkAnchor: (ws: Workspace, anchor: { sha: string; path: string; line: number }) => Promise<AnchorCheckResult>;
  /** `readConventions` of src/infra/code-fix/conventions.ts. */
  readConventions: (ws: Workspace, input: ReadConventionsInput) => Promise<Conventions>;
};

export function createFixWorkspaceNode(d: FixWorkspaceDeps): CodeFixNodeFn {
  return async (state, config) => {
    const fail = (failure: CodeFixReason, extra: Partial<CodeFixState> = {}): Partial<CodeFixState> => ({ stage: "workspace", failure, ...extra });
    if (attemptAborted(config)) return fail("attempt_timeout");
    const repo = state.repository;
    if (repo === null || state.commitSha === null || state.anchor === null) return fail("workspace_failed");

    let ws: Workspace;
    try {
      ws = await d.git.prepare({
        repo: repo.repo,
        cloneUrl: d.cloneUrl(repo.repo),
        baseBranch: repo.baseBranch,
        commitSha: state.commitSha,
        token: d.token,
        signal: signalOf(config),
      });
    } catch {
      return fail(attemptAborted(config) ? "attempt_timeout" : "workspace_failed");
    }
    d.session.workspace = ws;
    const baseCommitSha = ws.baseHead;

    try {
      const check = await d.checkAnchor(ws, { sha: state.commitSha, path: state.anchor.file, line: state.anchor.line });
      if (!check.ok) return fail(check.reason, { baseCommitSha });
      const conventions = await d.readConventions(ws, { anchor: { path: state.anchor.file, line: state.anchor.line }, testGlobs: repo.testGlobs });
      try {
        d.session.sandbox = d.sandboxFor(ws);
      } catch {
        return fail("sandbox_error", { baseCommitSha });
      }
      return {
        stage: "workspace",
        failure: null,
        baseCommitSha,
        conventions: { files: conventions.files.map((f) => ({ ...f })), totalChars: conventions.totalChars, truncated: conventions.truncated },
      };
    } catch {
      return fail(attemptAborted(config) ? "attempt_timeout" : "workspace_failed", { baseCommitSha });
    }
  };
}
