// check:secrets (spec 6.6; AC-41): scans the project tree for keys and tokens. Does not list files with
// `git ls-files`, because the folder still lives inside the course repository; Git is only queried to know whether a local `.env`
// is tracked. Runs in pre-commit and CI. Never prints the matched value: only path, line and pattern name.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PROJECT_ROOT } from "../src/infra/paths.ts";

/**
 * OpenRouter key, `sk-` format key, and APPROVAL_TOKEN or API_TOKEN assignments with a value of 8 characters or more.
 * The last two are built by concatenation, so this file does not match its own patterns.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-or-v1-[A-Za-z0-9]{20,}/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
  new RegExp("APPROVAL_TOKEN" + "=\\S{8,}", "g"),
  new RegExp("\\bAPI_TOKEN" + "=\\S{8,}", "g"),
];

const PATTERN_NAMES = ["OpenRouter key", "sk- key", "APPROVAL_TOKEN with a value", "API_TOKEN with a value"];

export type SecretFinding = { path: string; line: number; pattern: string };

export function scanText(text: string, path: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  text.split("\n").forEach((content, i) => {
    SECRET_PATTERNS.forEach((re, k) => {
      const hits = [...content.matchAll(new RegExp(re.source, "g"))].length;
      for (let n = 0; n < hits; n++) out.push({ path, line: i + 1, pattern: PATTERN_NAMES[k]! });
    });
  });
  return out;
}

/** Folders ignored at any level. */
const IGNORED_DIRS = new Set(["node_modules", ".git", "coverage"]);
/** Paths ignored from the root (with `/`). */
const IGNORED_PATHS = new Set(["reports", "web/dist", "web/public/demo", "coverage"]);
const isIgnoredFile = (rel: string) => /^data\/[^/]*\.db/.test(rel);
/**
 * Local environment file, kept out of commits by `.gitignore` (`.env` pattern, at any level). It is where the README tells
 * you to put the real key ("Using a real model (OpenRouter)"), so scanning it would break the pre-commit of anyone following the README. It only enters the
 * scan if tracked by Git. `.env.example` is still scanned.
 */
const LOCAL_ENV_FILES = new Set([".env"]);

export type ScanOptions = {
  /** Tells whether the relative path (with `/`) is tracked by Git. Default: `git ls-files --error-unmatch`. */
  isTracked?: (rel: string) => boolean;
};

/** `true` only when Git confirms the file is in the index; without Git or outside a repository, `false`. */
function trackedByGit(root: string, rel: string): boolean {
  const r = spawnSync("git", ["ls-files", "--error-unmatch", "--", rel], { cwd: root, stdio: "ignore" });
  return r.status === 0;
}

/** Walks the tree from `root` and returns the files, as `join(root, path)`, in stable order. */
export function listProjectFiles(root: string, opts: ScanOptions = {}): string[] {
  const isTracked = opts.isTracked ?? ((rel: string) => trackedByGit(root, rel));
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(root, path).split(sep).join("/");
      const st = statSync(path);
      if (st.isDirectory()) {
        if (IGNORED_DIRS.has(name) || IGNORED_PATHS.has(rel)) continue;
        walk(path);
      } else if (st.isFile() && !isIgnoredFile(rel)) {
        if (LOCAL_ENV_FILES.has(name) && !isTracked(rel)) continue;
        out.push(join(root, rel));
      }
    }
  };
  walk(root);
  return out;
}

/** A binary file (null byte in the first 8 KB) is excluded from the text scan. */
function readText(path: string): string | null {
  const buf = readFileSync(path);
  return buf.subarray(0, 8192).includes(0) ? null : buf.toString("utf8");
}

export function scanProject(root = PROJECT_ROOT, opts: ScanOptions = {}): { files: number; findings: SecretFinding[] } {
  const findings: SecretFinding[] = [];
  let files = 0;
  for (const file of listProjectFiles(root, opts)) {
    const text = readText(file);
    if (text === null) continue;
    files += 1;
    findings.push(...scanText(text, relative(root, file).split(sep).join("/")));
  }
  return { files, findings };
}

if (import.meta.main) {
  const { files, findings } = scanProject();
  if (findings.length > 0) {
    for (const f of findings) process.stderr.write(`${f.path}:${f.line}: possible secret (${f.pattern}); value omitted\n`);
    process.stderr.write(`check:secrets: ${findings.length} finding(s) in ${files} text file(s)\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`check:secrets: no secrets in ${files} text file(s)\n`);
  }
}
