// Code fixer ports (spec 009, decisions 3, 6, 7, 15 and 20). Types only: no logic, no node imports. The fixer graph
// receives a CodeHostReader, a GitWorkspacePort and a SandboxRunner, never a CodeHostWriter; only the publisher holds one.
import type { TestRunSummary } from "../../contracts/index.ts";

// ---------- workspace (git) ----------

export type PrepareWorkspaceInput = {
  /** Allowlisted `owner/name`; the clone URL is built from the allowlist, never from model or provider text. */
  repo: string;
  /** https clone URL from the allowlist. */
  cloneUrl: string;
  baseBranch: string;
  /** The resolved, code-host-confirmed release commit. */
  commitSha: string;
  /** Given to git only through the askpass script; never in a URL, argv or `.git/config`. */
  token: string | null;
  signal: AbortSignal;
};

export type FileMode = "100644" | "100755" | "120000" | "160000" | "other";

/** A file the diff touched, from `git diff --cached --numstat` and `git status --porcelain=v1 -z`. */
export type WorkspaceChange = {
  path: string;
  kind: "added" | "modified" | "deleted" | "renamed" | "mode_changed" | "other";
  added: number;
  removed: number;
  binary: boolean;
  symlink: boolean;
};

export type StagedDiff = {
  patch: string;
  changes: WorkspaceChange[];
};

/** An attempt directory with a shallow work tree at the base head. `dispose` removes it (called in a `finally`). */
export interface Workspace {
  /** `<attempt>` root, holding the siblings `repo/`, `tmp/`, `kit/` and `git/`. */
  readonly root: string;
  readonly repoDir: string;
  readonly tmpDir: string;
  readonly kitDir: string;
  /** The base branch head the work starts from. */
  readonly baseHead: string;
  /** File text at a commit, or null when it does not exist there. */
  readAt(sha: string, path: string): Promise<string | null>;
  /** Tree mode of a path at a commit, or null when absent. */
  modeAt(sha: string, path: string): Promise<FileMode | null>;
  /** `git diff --quiet <a> <b> -- <path>`. */
  sameAt(a: string, b: string, path: string): Promise<boolean>;
  /** Reads a regular work-tree file (lstat; null when missing or not regular). */
  readFile(path: string): Promise<string | null>;
  /** Writes a work-tree file; the path is already validated by the guards. */
  writeFile(path: string, content: string): Promise<void>;
  /** Repo-relative paths of tracked files matching any of the globs. */
  listFiles(globs: readonly string[]): Promise<string[]>;
  /** `git add -A` then the staged diff (no ext diff, no color, binary, find renames). */
  stagedDiff(): Promise<StagedDiff>;
  /**
   * The staged (index) blob of a path, after `stagedDiff`: the bytes the patch and numstat describe, which can differ
   * from the work tree when `.gitattributes` converts on checkout or add. Null when the path has no regular-file entry.
   */
  readStaged(path: string): Promise<string | null>;
  dispose(): Promise<void>;
}

export interface GitWorkspacePort {
  prepare(input: PrepareWorkspaceInput): Promise<Workspace>;
}

// ---------- sandbox ----------

export type SandboxRunInput = {
  /** Test files or validated globs passed to `node --test`; never a directory or a flag. */
  files: readonly string[];
  timeoutSec: number;
  signal: AbortSignal;
};

export type SandboxRunResult = TestRunSummary & {
  /** Capped, redacted tail of stdout and stderr; untrusted text. */
  outputTail: string;
};

export interface SandboxRunner {
  /** Runs inside the workspace the runner was built for; never throws for a failing or crashing suite. */
  run(input: SandboxRunInput): Promise<SandboxRunResult>;
}

// ---------- code host ----------

/** Fixed error kinds; a code-host error carries no body, header or token. */
export type CodeHostErrorKind =
  | "auth" | "forbidden" | "not_found" | "conflict" | "rate_limited" | "timeout" | "unavailable" | "bad_response" | "unsafe_input";

export interface CodeHostErrorLike {
  readonly name: "CodeHostError";
  readonly kind: CodeHostErrorKind;
  readonly status: number | null;
}

export type RepoRef = { owner: string; repo: string };

export type BranchInfo = { name: string; protected: boolean; headSha: string };

export type GitRefInfo = { ref: string; sha: string };

export type CommitInfo = { sha: string; tree: string; parents: string[] };

export type PullRequestInfo = { number: number; url: string; branch: string; draft: boolean };

export interface CodeHostReader {
  commitExists(r: RepoRef & { sha: string }): Promise<boolean>;
  branchInfo(r: RepoRef & { branch: string }): Promise<BranchInfo>;
  /** Paths changed between `base...head` (compare endpoint). */
  compareFiles(r: RepoRef & { base: string; head: string }): Promise<string[]>;
  findPullByHead(r: RepoRef & { branch: string }): Promise<PullRequestInfo | null>;
  getRef(r: RepoRef & { ref: string }): Promise<GitRefInfo | null>;
  getCommit(r: RepoRef & { sha: string }): Promise<CommitInfo>;
}

export type DraftPullRequestInput = RepoRef & {
  base: string;
  baseCommitSha: string;
  branch: string;
  title: string;
  body: string;
  commitMessage: string;
  author: { name: string; email: string; date: string };
  files: readonly { path: string; content: string }[];
  /** Persisted before the ref is created, so a retry reuses the same commit. */
  onCommit?: (commit: { sha: string; tree: string }) => Promise<void> | void;
};

/** Can only open a draft pull request: no merge, review, label, PUT, PATCH or DELETE. */
export interface CodeHostWriter {
  openDraftPullRequest(input: DraftPullRequestInput): Promise<PullRequestInfo>;
}
