// Spec 009, decision 7 (AC-65): the pure parts of the process sandbox. The runner builds the whole argv itself; the
// operator only names test globs. The environment comes from an allowlist and never from process.env. Results come only
// from the kit reporter's prefixed lines and are cross-checked with the exit code.
import type { CodeFixIsolation, TestFailure, TestRunSummary } from "../../contracts/index.ts";

/** Every report line the kit reporter writes starts with this, at the start of a line. */
export const SANDBOX_REPORT_PREFIX = "@@incident-copilot-sandbox-report@@ ";

export const DEFAULT_UNSHARE_PATH = "/usr/bin/unshare";

export const SANDBOX_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "CI", "NODE_ENV", "LANG", "TZ", "NO_COLOR"] as const;

/**
 * Keys the child can see that the parent never passes: `node --test` sets `NODE_TEST_WORKER_ID`, and macOS sets
 * `__CF_USER_TEXT_ENCODING` at process start (checked on Node 24.21, docs/api-notes.md). Neither carries a secret.
 */
export const RUNTIME_ADDED_ENV_KEYS = ["NODE_TEST_WORKER_ID", "__CF_USER_TEXT_ENCODING"] as const;

const SAFE_FILE_ARG = /^[A-Za-z0-9_./*{},-]+$/;

/** A test file or glob the runner may pass to `node --test`: allowlisted characters, no flag, no absolute path, no `..`. */
export function isSafeTestFileArg(arg: string): boolean {
  if (!SAFE_FILE_ARG.test(arg)) return false;
  if (arg.startsWith("-") || arg.startsWith("/") || arg.endsWith("/")) return false;
  return !arg.split("/").includes("..");
}

export type SandboxArgvInput = {
  execPath: string;
  /** The attempt root, holding `repo/`, `kit/` and `tmp/`. */
  attemptDir: string;
  files: readonly string[];
  network: CodeFixIsolation;
  /** Test-only modules imported before the kit preload; each is also read-granted. */
  extraImports?: readonly string[];
  unsharePath?: string;
  /** Default true. Only the self-test's raw OS phase runs without the preload. */
  preload?: boolean;
};

function trimSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

export function sandboxPaths(attemptDir: string): { repo: string; kit: string; tmp: string; preload: string; reporter: string } {
  const root = trimSlash(attemptDir);
  return {
    repo: `${root}/repo`,
    kit: `${root}/kit`,
    tmp: `${root}/tmp`,
    preload: `${root}/kit/preload.ts`,
    reporter: `${root}/kit/reporter.ts`,
  };
}

/**
 * The full argv, `argv[0]` being the command. Node 24.21 does not split a comma list in `--allow-fs-read=` (it grants one
 * literal path), so each grant is its own flag. Never grants child process, worker, addon, WASI or inspector rights.
 */
export function buildSandboxArgv(input: SandboxArgvInput): string[] {
  if (input.files.length === 0) throw new Error("sandbox: no test files");
  for (const f of input.files) if (!isSafeTestFileArg(f)) throw new Error("sandbox: unsafe test file argument");
  const extra = input.extraImports ?? [];
  for (const p of extra) if (!p.startsWith("/") || p.includes(",")) throw new Error("sandbox: extra imports must be absolute paths");
  const p = sandboxPaths(input.attemptDir);
  const node = [
    input.execPath,
    "--permission",
    `--allow-fs-read=${p.repo}`,
    `--allow-fs-read=${p.kit}`,
    `--allow-fs-read=${p.tmp}`,
    ...extra.map((x) => `--allow-fs-read=${x}`),
    `--allow-fs-write=${p.tmp}`,
    "--disallow-code-generation-from-strings",
    ...extra.map((x) => `--import=${x}`),
    ...(input.preload === false ? [] : [`--import=${p.preload}`]),
    "--test",
    "--test-isolation=none",
    `--test-reporter=${p.reporter}`,
    "--test-reporter-destination=stdout",
    ...input.files,
  ];
  if (input.network !== "isolated") return node;
  return [input.unsharePath ?? DEFAULT_UNSHARE_PATH, "--user", "--map-root-user", "--net", "--", ...node];
}

/** Built from an allowlist only; never reads `process.env`. */
export function buildSandboxEnv(input: { execPath: string; attemptDir: string }): Record<(typeof SANDBOX_ENV_KEYS)[number], string> {
  const p = sandboxPaths(input.attemptDir);
  const slash = input.execPath.lastIndexOf("/");
  const nodeDir = slash > 0 ? input.execPath.slice(0, slash) : "/usr/bin";
  return {
    PATH: `${nodeDir}:/usr/bin:/bin`,
    HOME: p.tmp,
    TMPDIR: p.tmp,
    CI: "1",
    NODE_ENV: "test",
    LANG: "C.UTF-8",
    TZ: "UTC",
    NO_COLOR: "1",
  };
}

// ---------- report parsing ----------

export type ReportedTestStatus = "passed" | "failed" | "skipped" | "todo" | "cancelled";

export type ReportedTest = {
  name: string;
  /** Repo-relative, or "" when the file is outside the work tree. */
  file: string;
  status: ReportedTestStatus;
  errorName: string;
  message: string;
  frames: { file: string; line: number }[];
};

const STATUSES: ReadonlySet<string> = new Set(["passed", "failed", "skipped", "todo", "cancelled"]);
const MAX_FRAMES = 10;
const MAX_FAILURES = 5;

function clip(text: unknown, max: number): string {
  const s = typeof text === "string" ? text : "";
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Repo-relative POSIX path, or null when the path is outside the root (a sibling sharing the prefix included). */
function repoRelative(file: unknown, repoRoot: string): string | null {
  if (typeof file !== "string" || file.length === 0) return null;
  const root = trimSlash(repoRoot) + "/";
  if (!file.startsWith(root)) return null;
  const rel = file.slice(root.length);
  if (rel.length === 0 || rel.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) return null;
  return rel;
}

function framesOf(raw: unknown, repoRoot: string): { file: string; line: number }[] {
  if (!Array.isArray(raw)) return [];
  const out: { file: string; line: number }[] = [];
  for (const fr of raw) {
    if (out.length >= MAX_FRAMES) break;
    if (!fr || typeof fr !== "object") continue;
    const { file, line } = fr as { file?: unknown; line?: unknown };
    const rel = repoRelative(file, repoRoot);
    if (rel === null || typeof line !== "number" || !Number.isInteger(line) || line <= 0) continue;
    out.push({ file: clip(rel, 300), line });
  }
  return out;
}

type ParsedLines = { tests: ReportedTest[]; summaries: number };

/** Only lines that start with the prefix; anything malformed or of unknown shape is ignored. */
export function parseReportLines(stdout: string, repoRoot: string): ParsedLines {
  const tests: ReportedTest[] = [];
  let summaries = 0;
  for (const raw of stdout.split("\n")) {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!text.startsWith(SANDBOX_REPORT_PREFIX)) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(text.slice(SANDBOX_REPORT_PREFIX.length));
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
    const r = rec as Record<string, unknown>;
    if (r.kind === "summary") {
      summaries++;
      continue;
    }
    if (r.kind !== "test" || typeof r.status !== "string" || !STATUSES.has(r.status)) continue;
    tests.push({
      name: clip(r.name, 200),
      file: clip(repoRelative(r.file, repoRoot) ?? "", 300),
      status: r.status as ReportedTestStatus,
      errorName: clip(r.errorName, 120),
      message: clip(r.message, 200),
      frames: framesOf(r.frames, repoRoot),
    });
  }
  return { tests, summaries };
}

/**
 * Summary from the prefixed lines, cross-checked with the exit code. An empty report (no single summary line), zero
 * tests, exit 0 with a failure, a non-zero exit with no failure, or a signal exit all give `error`, never `passed`.
 */
export function parseReport(
  stdout: string,
  exitCode: number | null,
  opts: { repoRoot: string; durationMs?: number },
): TestRunSummary {
  const { tests, summaries } = parseReportLines(stdout, opts.repoRoot);
  const count = (s: ReportedTestStatus) => tests.filter((t) => t.status === s).length;
  const failed = count("failed");
  const cancelled = count("cancelled");
  const failures: TestFailure[] = tests
    .filter((t) => t.status === "failed" || t.status === "cancelled")
    .slice(0, MAX_FAILURES)
    .map((t) => ({ name: t.name, file: t.file, errorName: t.errorName, message: t.message, frames: t.frames }));
  const reportedFailures = failed + cancelled;
  let outcome: TestRunSummary["outcome"];
  if (summaries !== 1 || tests.length === 0 || exitCode === null) outcome = "error";
  else if (exitCode === 0 && reportedFailures > 0) outcome = "error";
  else if (exitCode !== 0 && reportedFailures === 0) outcome = "error";
  else outcome = reportedFailures > 0 ? "failed" : "passed";
  return {
    outcome,
    exitCode,
    total: tests.length,
    passed: count("passed"),
    failed,
    skipped: count("skipped"),
    todo: count("todo"),
    cancelled,
    durationMs: Math.max(0, Math.round(opts.durationMs ?? 0)),
    failures,
  };
}
