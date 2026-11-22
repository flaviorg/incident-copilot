// The code fixer's git workspace: a hardened shallow fetch into a temporary attempt directory (spec 009, decision 6;
// AC-62, AC-64). Every git child goes through execFile (no shell) with a fixed env that ignores the host's global and
// system config, and with -c flags that disable hooks, symlinks, fsmonitor, credential helpers, submodules and every
// protocol but https. The token reaches git only through an askpass script that reads it from the env of fetch children.
import { execFile as nodeExecFile } from "node:child_process";
import type { ExecFileException, ExecFileOptionsWithStringEncoding } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile as fsReadFile, realpath, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, sep } from "node:path";
import type {
  FileMode, GitWorkspacePort, PrepareWorkspaceInput, StagedDiff, Workspace, WorkspaceChange,
} from "../../domain/code-fix/ports.ts";
import { sanitizeText } from "../../domain/ingest/sanitize.ts";
import { redactThenClip } from "../redact.ts";

/** The callback form of `child_process.execFile`, injectable so tests can capture argv and env. */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => unknown;

export type WorkspaceErrorKind = "unsafe_input" | "git_failed" | "timeout" | "aborted" | "io";

/** Fixed kinds; the message never carries argv, a URL with credentials or a token (stderr is redacted and clipped). */
export class WorkspaceError extends Error {
  override readonly name = "WorkspaceError";
  readonly kind: WorkspaceErrorKind;
  constructor(kind: WorkspaceErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** The -c flags of decision 6, on every git child. */
export const GIT_SAFE_CONFIG: readonly string[] = [
  "core.hooksPath=/dev/null",
  "core.symlinks=false",
  "core.fsmonitor=false",
  "credential.helper=",
  "protocol.allow=never",
  "protocol.https.allow=always",
  "submodule.recurse=false",
  // No attributes or ignore rules from outside the repository, and no line-ending conversion beyond the repository's own
  // .gitattributes: what is staged is what the post-images (read from the index) contain.
  "core.attributesFile=/dev/null",
  "core.excludesFile=/dev/null",
  "core.autocrlf=false",
  "core.eol=lf",
];

export type GitCliWorkspaceOptions = {
  /** Test only; config cannot set it. Allows file:// remotes (and git's file protocol). */
  allowFileProtocol?: boolean;
  /** Maps the input to the remote URL; defaults to `input.cloneUrl`. Tests point it at a local bare repository. */
  remoteUrlFor?: (input: PrepareWorkspaceInput) => string;
  /** Test only; config cannot set it. Parent directory of the attempt directories; defaults to the real os.tmpdir(). */
  tmpRoot?: string;
  execFile?: ExecFileLike;
  gitBinary?: string;
  fetchTimeoutMs?: number;
  commandTimeoutMs?: number;
  /** Extra values to redact from git's stderr (the token is always redacted). */
  secrets?: readonly string[];
};

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const STDERR_MAX = 400;
const MAX_BUFFER = 16 * 1024 * 1024;

const ASKPASS_SCRIPT = [
  "#!/bin/sh",
  "# Written by the incident copilot for one fetch; prints the token from the env, never stores it.",
  'case "$1" in',
  "  Username*) printf '%s\\n' x-access-token ;;",
  "  *) printf '%s\\n' \"$IC_GIT_PASSWORD\" ;;",
  "esac",
  "",
].join("\n");

/** A repo-relative POSIX path: no absolute, Windows or parent segment, no NUL or backslash, nothing under `.git`. */
export function isSafeRepoPath(p: string): boolean {
  if (p.length === 0 || p.length > 300) return false;
  if (p.includes("\0") || p.includes("\\") || p.startsWith("/") || p.startsWith("-")) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  const segments = p.split("/");
  return segments.every((s) => s !== "" && s !== "." && s !== ".." && s.toLowerCase() !== ".git");
}

/** A branch name git would accept that cannot be read as an option or a revision expression. */
export function isSafeBranch(b: string): boolean {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(b)) return false;
  if (b.startsWith("-") || b.startsWith("/") || b.endsWith("/") || b.endsWith(".") || b.endsWith(".lock")) return false;
  return !b.includes("..") && !b.includes("//") && !b.split("/").some((s) => s.startsWith("."));
}

/** https only (no credentials, query or fragment); file:// only when the test-only option allows it. */
export function validateRemoteUrl(raw: string, allowFileProtocol: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WorkspaceError("unsafe_input", "remote URL is not a valid URL");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new WorkspaceError("unsafe_input", "remote URL must not carry credentials, a query or a fragment");
  }
  if (url.protocol === "https:" && url.hostname !== "") return url.href;
  if (url.protocol === "file:" && allowFileProtocol && url.hostname === "") return url.href;
  throw new WorkspaceError("unsafe_input", `remote URL protocol not allowed: ${url.protocol.slice(0, 20)}`);
}

type GitResult = { code: number; stdout: string };

type Runner = {
  git(args: readonly string[], opts?: { okCodes?: readonly number[]; withToken?: boolean; timeoutMs?: number }): Promise<GitResult>;
};

function toMode(mode: string): FileMode {
  return mode === "100644" || mode === "100755" || mode === "120000" || mode === "160000" ? mode : "other";
}

function assertSha(sha: string): void {
  if (!SHA.test(sha)) throw new WorkspaceError("unsafe_input", "commit must be a 40-hex SHA");
}

function assertPath(p: string): void {
  if (!isSafeRepoPath(p)) throw new WorkspaceError("unsafe_input", "path is not a safe repo-relative path");
}

class GitWorkspace implements Workspace {
  readonly root: string;
  readonly repoDir: string;
  readonly tmpDir: string;
  readonly kitDir: string;
  readonly baseHead: string;
  readonly #runner: Runner;

  constructor(root: string, baseHead: string, runner: Runner) {
    this.root = root;
    this.repoDir = join(root, "repo");
    this.tmpDir = join(root, "tmp");
    this.kitDir = join(root, "kit");
    this.baseHead = baseHead;
    this.#runner = runner;
  }

  async #entry(sha: string, path: string): Promise<{ mode: string; type: string; object: string } | null> {
    assertSha(sha);
    assertPath(path);
    const { stdout } = await this.#runner.git(["ls-tree", "-z", "--full-tree", sha, "--", path]);
    for (const record of stdout.split("\0")) {
      const tab = record.indexOf("\t");
      if (tab < 0 || record.slice(tab + 1) !== path) continue;
      const [mode, type, object] = record.slice(0, tab).split(" ");
      if (mode && type && object) return { mode, type, object };
    }
    return null;
  }

  async readAt(sha: string, path: string): Promise<string | null> {
    const entry = await this.#entry(sha, path);
    if (!entry || entry.type !== "blob") return null;
    const { stdout } = await this.#runner.git(["cat-file", "blob", entry.object]);
    return stdout;
  }

  async modeAt(sha: string, path: string): Promise<FileMode | null> {
    const entry = await this.#entry(sha, path);
    return entry ? toMode(entry.mode) : null;
  }

  async sameAt(a: string, b: string, path: string): Promise<boolean> {
    assertSha(a);
    assertSha(b);
    assertPath(path);
    const { code } = await this.#runner.git(["diff", "--quiet", "--no-ext-diff", "--no-textconv", a, b, "--", path], { okCodes: [0, 1] });
    return code === 0;
  }

  /**
   * The absolute work-tree path, after checking its parent resolves inside the work tree (no symlinked directory);
   * null when it escapes.
   */
  async #resolve(path: string): Promise<string | null> {
    assertPath(path);
    const full = join(this.repoDir, ...path.split("/"));
    const repoReal = await realpath(this.repoDir);
    let parent: string;
    try {
      parent = await realpath(dirname(full));
    } catch {
      return full; // a missing parent cannot be a symlink; writeFile creates it
    }
    return parent === repoReal || parent.startsWith(repoReal + sep) ? full : null;
  }

  async readFile(path: string): Promise<string | null> {
    const full = await this.#resolve(path);
    if (full === null) return null;
    try {
      const st = await lstat(full);
      if (!st.isFile()) return null;
      return await fsReadFile(full, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") return null;
      throw new WorkspaceError("io", "could not read a work-tree file");
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    const escapes = () => new WorkspaceError("unsafe_input", "path resolves outside the work tree");
    const full = await this.#resolve(path);
    if (full === null) throw escapes();
    await mkdir(dirname(full), { recursive: true });
    if ((await this.#resolve(path)) === null) throw escapes(); // re-check after creating the parents
    try {
      const st = await lstat(full);
      if (!st.isFile()) throw new WorkspaceError("unsafe_input", "path exists and is not a regular file");
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new WorkspaceError("io", "could not stat a work-tree file");
    }
    await fsWriteFile(full, content, "utf8");
  }

  async listFiles(globs: readonly string[]): Promise<string[]> {
    if (globs.length === 0) return [];
    const { stdout } = await this.#runner.git(["ls-files", "-z", "--cached"]);
    return stdout
      .split("\0")
      .filter((p) => p !== "" && isSafeRepoPath(p) && globs.some((g) => posix.matchesGlob(p, g)))
      .sort();
  }

  async stagedDiff(): Promise<StagedDiff> {
    const r = this.#runner;
    await r.git(["add", "-A"]);
    const common = ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--find-renames"];
    const raw = (await r.git([...common, "--raw", "-z"])).stdout;
    const numstat = (await r.git([...common, "--numstat", "-z"])).stdout;
    const patch = (await r.git(common)).stdout;
    const status = (await r.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
    return { patch, changes: buildChanges(raw, numstat, status) };
  }

  async readStaged(path: string): Promise<string | null> {
    assertPath(path);
    const { stdout } = await this.#runner.git(["ls-files", "-z", "--stage", "--", path]);
    for (const record of stdout.split("\0")) {
      const tab = record.indexOf("\t");
      if (tab < 0 || record.slice(tab + 1) !== path) continue;
      const [mode, object, stage] = record.slice(0, tab).split(" ");
      if ((mode !== "100644" && mode !== "100755") || stage !== "0" || !object || !/^[0-9a-f]{40,64}$/.test(object)) return null;
      return (await this.#runner.git(["cat-file", "blob", object])).stdout;
    }
    return null;
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

function buildChanges(raw: string, numstat: string, status: string): WorkspaceChange[] {
  const changes = new Map<string, WorkspaceChange>();
  const rawTokens = raw.split("\0");
  for (let i = 0; i < rawTokens.length; i++) {
    const head = rawTokens[i]!;
    if (!head.startsWith(":")) continue;
    const [oldMode, newMode, , , letterRaw] = head.slice(1).split(" ");
    const letter = (letterRaw ?? "").charAt(0);
    let path = rawTokens[++i] ?? "";
    if (letter === "R" || letter === "C") path = rawTokens[++i] ?? path;
    const kind: WorkspaceChange["kind"] =
      letter === "A" ? "added"
      : letter === "D" ? "deleted"
      : letter === "R" ? "renamed"
      : letter === "T" ? "mode_changed"
      : letter === "M" ? (oldMode === newMode ? "modified" : "mode_changed")
      : "other";
    changes.set(path, { path, kind, added: 0, removed: 0, binary: false, symlink: oldMode === "120000" || newMode === "120000" });
  }
  const numTokens = numstat.split("\0");
  for (let i = 0; i < numTokens.length; i++) {
    const rec = numTokens[i]!;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    let path = m[3]!;
    if (path === "") {
      i++; // old path of a rename
      path = numTokens[++i] ?? "";
    }
    const c = changes.get(path);
    if (!c) continue;
    c.binary = m[1] === "-" || m[2] === "-";
    c.added = c.binary ? 0 : Number(m[1]);
    c.removed = c.binary ? 0 : Number(m[2]);
  }
  const stTokens = status.split("\0");
  for (let i = 0; i < stTokens.length; i++) {
    const rec = stTokens[i]!;
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const path = rec.slice(3);
    if (xy.includes("R") || xy.includes("C")) i++; // the original path follows
    if (!changes.has(path)) changes.set(path, { path, kind: "other", added: 0, removed: 0, binary: false, symlink: false });
  }
  return [...changes.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export class GitCliWorkspace implements GitWorkspacePort {
  readonly #opts: GitCliWorkspaceOptions;

  constructor(opts: GitCliWorkspaceOptions = {}) {
    this.#opts = opts;
  }

  async prepare(input: PrepareWorkspaceInput): Promise<Workspace> {
    const allowFile = this.#opts.allowFileProtocol === true;
    if (!REPO.test(input.repo)) throw new WorkspaceError("unsafe_input", "repo must be owner/name");
    if (!SHA.test(input.commitSha)) throw new WorkspaceError("unsafe_input", "commit must be a 40-hex SHA");
    if (!isSafeBranch(input.baseBranch)) throw new WorkspaceError("unsafe_input", "base branch name is not allowed");
    if (input.token !== null && (input.token === "" || /[\0\r\n]/.test(input.token))) {
      throw new WorkspaceError("unsafe_input", "token is not a single-line value");
    }
    const remote = validateRemoteUrl(this.#opts.remoteUrlFor ? this.#opts.remoteUrlFor(input) : input.cloneUrl, allowFile);
    if (input.signal.aborted) throw new WorkspaceError("aborted", "workspace preparation was aborted");

    const root = await mkdtemp(join(await realpath(this.#opts.tmpRoot ?? tmpdir()), "ic-fix-"));
    try {
      for (const d of ["repo", "tmp", "kit", "git"]) await mkdir(join(root, d), { mode: 0o700 });
      let askpass: string | null = null;
      if (input.token !== null) {
        askpass = join(root, "git", "askpass.sh");
        await fsWriteFile(askpass, ASKPASS_SCRIPT, { mode: 0o700 });
        await chmod(askpass, 0o700);
      }
      const runner = this.#runner(root, input, askpass, allowFile);
      const branchRef = `refs/remotes/origin/${input.baseBranch}`;
      await runner.git(["init", "--quiet", "--template="]);
      await runner.git(["remote", "add", "origin", remote]);
      await runner.git(
        ["fetch", "--depth", "1", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "origin",
          `+refs/heads/${input.baseBranch}:${branchRef}`, input.commitSha],
        { withToken: true, timeoutMs: this.#opts.fetchTimeoutMs ?? 120_000 },
      );
      const baseHead = (await runner.git(["rev-parse", "--verify", "--end-of-options", `${branchRef}^{commit}`])).stdout.trim();
      if (!SHA.test(baseHead)) throw new WorkspaceError("git_failed", "base branch head is not a commit");
      await runner.git(["cat-file", "-e", `${input.commitSha}^{commit}`]);
      await runner.git(["checkout", "--quiet", "--detach", baseHead]);
      return new GitWorkspace(root, baseHead, runner);
    } catch (err) {
      await rm(root, { recursive: true, force: true });
      if (err instanceof WorkspaceError) throw err;
      throw new WorkspaceError("io", "could not prepare the attempt directory");
    }
  }

  #runner(root: string, input: PrepareWorkspaceInput, askpass: string | null, allowFile: boolean): Runner {
    const exec = this.#opts.execFile ?? (nodeExecFile as unknown as ExecFileLike);
    const binary = this.#opts.gitBinary ?? "git";
    const secrets = [...(this.#opts.secrets ?? []), ...(input.token ? [input.token] : [])];
    const flags = [...GIT_SAFE_CONFIG, ...(allowFile ? ["protocol.file.allow=always"] : [])].flatMap((c) => ["-c", c]);
    const repoDir = join(root, "repo");
    // Not <attempt>/tmp: the sandbox can write there, and git would read $XDG_CONFIG_HOME/git/attributes and ignore.
    const home = join(root, "git");
    const baseEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LC_ALL: "C",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_CEILING_DIRECTORIES: root,
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_LITERAL_PATHSPECS: "1",
      HOME: home,
      TMPDIR: home,
      XDG_CONFIG_HOME: home,
    };
    const fetchEnv: Record<string, string> =
      askpass && input.token ? { ...baseEnv, GIT_ASKPASS: askpass, IC_GIT_PASSWORD: input.token } : baseEnv;

    return {
      git: (args, opts = {}) =>
        new Promise<GitResult>((resolve, reject) => {
          const sub = args[0] ?? "git";
          const okCodes = opts.okCodes ?? [0];
          if (input.signal.aborted) {
            reject(new WorkspaceError("aborted", `git ${sub} was aborted`));
            return;
          }
          exec(
            binary,
            [...flags, ...args],
            {
              cwd: repoDir,
              env: opts.withToken ? fetchEnv : baseEnv,
              encoding: "utf8",
              timeout: opts.timeoutMs ?? this.#opts.commandTimeoutMs ?? 30_000,
              killSignal: "SIGKILL",
              maxBuffer: MAX_BUFFER,
              windowsHide: true,
              signal: input.signal,
            },
            (error, stdout, stderr) => {
              if (!error) {
                resolve({ code: 0, stdout });
                return;
              }
              const code = typeof error.code === "number" ? error.code : null;
              if (code !== null && okCodes.includes(code)) {
                resolve({ code, stdout });
                return;
              }
              const detail = redactThenClip(sanitizeText(String(stderr ?? ""), STDERR_MAX * 2), STDERR_MAX, secrets);
              if (error.name === "AbortError" || input.signal.aborted) reject(new WorkspaceError("aborted", `git ${sub} was aborted`));
              else if (error.killed) reject(new WorkspaceError("timeout", `git ${sub} timed out`));
              else reject(new WorkspaceError("git_failed", `git ${sub} failed (exit ${code ?? "?"})${detail ? `: ${detail}` : ""}`));
            },
          );
        }),
    };
  }
}

// ---------- anchor checks (decision 6) ----------

export type AnchorCheckResult =
  | { ok: true }
  | { ok: false; reason: "file_changed_since_release" | "line_out_of_range" | "file_not_regular" };

/**
 * The anchor file must exist at the release commit with the line in range, be a 100644 blob at the release and the base
 * head (no symlink, executable or submodule), and be byte-identical at both. A file missing at either commit, or one
 * that differs, is `file_changed_since_release`.
 */
export async function anchorChecks(ws: Workspace, anchor: { sha: string; path: string; line: number }): Promise<AnchorCheckResult> {
  const modeAtRelease = await ws.modeAt(anchor.sha, anchor.path);
  if (modeAtRelease === null) return { ok: false, reason: "file_changed_since_release" };
  if (modeAtRelease !== "100644") return { ok: false, reason: "file_not_regular" };
  const text = (await ws.readAt(anchor.sha, anchor.path)) ?? "";
  const lines = text.split("\n");
  const count = text.endsWith("\n") ? lines.length - 1 : lines.length;
  if (!Number.isInteger(anchor.line) || anchor.line < 1 || anchor.line > count) return { ok: false, reason: "line_out_of_range" };
  const modeAtHead = await ws.modeAt(ws.baseHead, anchor.path);
  if (modeAtHead === null) return { ok: false, reason: "file_changed_since_release" };
  if (modeAtHead !== "100644") return { ok: false, reason: "file_not_regular" };
  if (!(await ws.sameAt(anchor.sha, ws.baseHead, anchor.path))) return { ok: false, reason: "file_changed_since_release" };
  return { ok: true };
}
