// GitHub REST paths and input validation (spec 009, decision 20). Every value that enters a path is validated first and
// URL-encoded; the builders return paths relative to the configured API URL.
//
// VERIFY AGAINST DOCS: the paths below follow the GitHub REST documentation as we read it (Git database: blobs, trees,
// commits, refs; branches; compare; pulls). Not confirmed against a live API: that a branch name with `/` is accepted
// with its slashes kept literal in `/branches/{branch}`, `/compare/{base}...{head}` and `/git/ref/heads/{branch}`, and
// that `compare` lists at most 300 files. See docs/code-fixer.md, "Unverified".
import { CodeHostError } from "./errors.ts";

/** Owner and repository names (spec 009, decision 20). `.` and `..` match the class but are refused separately. */
export const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
export const SHA_PATTERN = /^[0-9a-fA-F]{40}$/;
/** The only branches the writer may create. */
export const FIX_BRANCH_PATTERN = /^incident-copilot\/fix-[A-Za-z0-9_-]{1,64}$/;
export const FIX_BRANCH_PREFIX = "incident-copilot/fix-";

const unsafe = () => new CodeHostError("unsafe_input");

export function assertName(value: string): string {
  if (typeof value !== "string" || !NAME_PATTERN.test(value) || value === "." || value === "..") throw unsafe();
  return value;
}

export function assertSha(value: string): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) throw unsafe();
  return value.toLowerCase();
}

/**
 * A branch name in the subset git and GitHub both accept: segments of `[A-Za-z0-9._-]` joined by `/`, no empty, `.` or
 * `..` segment, no segment starting with `.` or ending with `.lock`, no `..` anywhere, at most 200 characters.
 */
export function assertBranch(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || value.includes("..")) throw unsafe();
  for (const seg of value.split("/")) {
    if (!/^[A-Za-z0-9._-]+$/.test(seg) || seg.startsWith(".") || seg.endsWith(".lock")) throw unsafe();
  }
  return value;
}

export function assertFixBranch(value: string): string {
  assertBranch(value);
  if (!FIX_BRANCH_PATTERN.test(value)) throw unsafe();
  return value;
}

/** A compare endpoint side: a 40-hex SHA or a branch name. */
export function assertRevision(value: string): string {
  return typeof value === "string" && SHA_PATTERN.test(value) ? value.toLowerCase() : assertBranch(value);
}

/** `refs/heads/<branch>` or `heads/<branch>`; only branch refs are read. Returns the branch. */
export function branchOfRef(ref: string): string {
  if (typeof ref !== "string") throw unsafe();
  const m = /^(?:refs\/)?heads\/(.+)$/.exec(ref);
  if (!m) throw unsafe();
  return assertBranch(m[1]!);
}

/** A repository-relative file path for a tree entry: no absolute, `.`/`..` segment, backslash or control character. */
export function assertFilePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) throw unsafe();
  // eslint-disable-next-line no-control-regex
  if (value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) throw unsafe();
  for (const seg of value.split("/")) if (seg === "" || seg === "." || seg === "..") throw unsafe();
  return value;
}

const enc = encodeURIComponent;
/** Encodes each `/`-separated segment and keeps the slashes. */
const encPath = (branch: string) => branch.split("/").map(enc).join("/");
const repoPath = (owner: string, repo: string) => `/repos/${enc(owner)}/${enc(repo)}`;

export const githubPaths = {
  /** GET: commit object with `tree.sha` and `parents[].sha`; 404 when absent. Verify against docs. */
  gitCommit: (o: string, r: string, sha: string) => `${repoPath(o, r)}/git/commits/${enc(sha)}`,
  /** POST: create a commit. Verify against docs. */
  gitCommits: (o: string, r: string) => `${repoPath(o, r)}/git/commits`,
  /** POST: create a blob. Verify against docs. */
  gitBlobs: (o: string, r: string) => `${repoPath(o, r)}/git/blobs`,
  /** POST: create a tree on `base_tree`. Verify against docs. */
  gitTrees: (o: string, r: string) => `${repoPath(o, r)}/git/trees`,
  /** POST: create a ref. Verify against docs. */
  gitRefs: (o: string, r: string) => `${repoPath(o, r)}/git/refs`,
  /** GET: one branch ref (`/git/ref/heads/{branch}`, singular `ref`); 404 when absent. Verify against docs. */
  gitBranchRef: (o: string, r: string, branch: string) => `${repoPath(o, r)}/git/ref/heads/${encPath(branch)}`,
  /** GET: branch with `protected` and `commit.sha`. Verify against docs. */
  branch: (o: string, r: string, branch: string) => `${repoPath(o, r)}/branches/${encPath(branch)}`,
  /** GET: three-dot compare with `files[]`. Verify against docs. */
  compare: (o: string, r: string, base: string, head: string) => `${repoPath(o, r)}/compare/${encPath(base)}...${encPath(head)}`,
  /** GET: pulls whose head is `owner:branch`, in any state. Verify against docs. */
  pullsByHead: (o: string, r: string, branch: string) => `${repoPath(o, r)}/pulls?head=${enc(o)}:${enc(branch)}&state=all&per_page=10`,
  /** POST: open a pull request. Verify against docs. */
  pulls: (o: string, r: string) => `${repoPath(o, r)}/pulls`,
};
