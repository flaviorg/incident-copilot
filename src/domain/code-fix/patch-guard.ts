// Deterministic guards over the model-written source edits and over the real staged diff (spec 009, decisions 10 and
// 11; AC-70, AC-71). Both collect every violation at once and return fixed English sentences that go back to the patch
// author as feedback; a message never echoes file content. A heuristic floor: isolation and human approval are the real
// controls. Pure: no node imports.
import type { StackFrame } from "../../contracts/index.ts";
import type { CodeFixLimits } from "./limits.ts";
import { effectiveLimits } from "./limits.ts";
import type { WorkspaceChange } from "./ports.ts";
import type { StatusEntry } from "./diff-parse.ts";
import type { GuardResult } from "./test-guard.ts";
import { countChangedLines, diffLines, findOccurrences, lineCount, normalizeEol } from "./edits.ts";
import { stripPathPrefix } from "./frames.ts";
import { injectionScan } from "./injection-scan.ts";
import { isDenied, matchesAnyGlob, toSafeRelPath } from "./paths.ts";

export const PATCH_GUARD_CODES = [
  "path_escape", "path_denied", "not_source_glob", "edits_test_file", "test_path_not_test", "edit_outside_frames",
  "too_many_files", "too_many_source_lines", "too_many_total_lines", "too_many_edits", "new_import", "dangerous_call",
  "assert_removed", "injection_text", "delete_file", "rename_file", "mode_change", "binary", "symlink", "unexpected_file",
] as const satisfies readonly string[];
export type PatchGuardCode = (typeof PATCH_GUARD_CODES)[number];

const MESSAGES: Record<PatchGuardCode, string> = {
  path_escape: "Every edited path must be a plain repo-relative POSIX path with no '..', absolute, Windows or home path.",
  path_denied: "An edit touches a denied path; configuration, CI, infrastructure, security and lock files cannot be changed.",
  not_source_glob: "Every edited file must match the repository's source globs.",
  edits_test_file: "The patch must not edit the new test file or any file matching the test globs.",
  test_path_not_test: "The new test file must match the repository's test globs and must not match its source globs.",
  edit_outside_frames: "Every edited file must be in the error's in-app stack frames, and one edit must be within 20 lines of the failing line with a search text found exactly once.",
  too_many_files: "The change touches more files than allowed (the new test included).",
  too_many_source_lines: "The source edits change more lines than allowed (added plus removed).",
  too_many_total_lines: "The change is larger than the allowed total number of lines (the new test included).",
  too_many_edits: "The patch has more edits than allowed.",
  new_import: "The patch must not add an import, require or dynamic import.",
  dangerous_call: "The patch adds a process, console, environment, network, eval, filesystem or runtime call.",
  assert_removed: "The patch must not remove or change an assertion.",
  injection_text: "The patch or its rationale contains text that addresses the reviewer or the model; remove it.",
  delete_file: "The change must not delete a file.",
  rename_file: "The change must not rename or copy a file.",
  mode_change: "The change must not change a file mode.",
  binary: "The change must not touch a binary file.",
  symlink: "The change must not add or edit a symbolic link.",
  unexpected_file: "The staged diff must list exactly the new test file as added and the edited source files as modified.",
};

/** Lines around the anchor line that count as near the failing frame. */
export const ANCHOR_HUNK_WINDOW = 20;

const IMPORT_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bimport\b/,
  /\brequire\b/,
  /\bexport\b[^\n]*\bfrom\s*["'`]/,
]);

export const DANGEROUS_PATTERNS: readonly RegExp[] = Object.freeze([
  /child_process/,
  /\bprocess\s*(?:\.|\?\.|\[)/,
  /\bfetch\s*\(/,
  /\beval\s*\(/,
  /\bnew\s+Function\b/,
  /\bFunction\s*\(/,
  /\bglobalThis\s*(?:\[|\?\.\[)/,
  /\bconsole\s*(?:\.|\?\.|\[)/,
  /\bnode:(?:net|http|https|http2|tls|dgram|dns|fs|vm|worker_threads|child_process)\b/,
  /\bDeno\s*\./,
  /\bBun\s*\./,
]);

const ASSERTION = /\bassert\b/;

export type PatchEdit = { path: string; search: string; replace: string };

type SizeLimits = Partial<Pick<CodeFixLimits, "maxFiles" | "maxSourceLines" | "maxTotalLines" | "maxEdits">>;

export type PatchGuardContext = {
  /** The guarded new test file; counted in the file and total-line limits, never shown to the patch author. */
  test: { path: string; content: string };
  /** Repo-relative anchor path and line (from connector data). */
  anchor: { path: string; line: number };
  /** Repo-relative paths of the event's in-app frames (see `inAppRepoPaths`). */
  inAppPaths: readonly string[];
  sourceGlobs: readonly string[];
  testGlobs: readonly string[];
  /** Added to `BUILT_IN_DENIED`. */
  deniedPaths: readonly string[];
  /** Work-tree text of the files the edits target, used to locate each hunk. */
  originals: Readonly<Record<string, string | null | undefined>>;
  /** Clamped through `effectiveLimits`: config can only lower the ceilings. */
  limits: SizeLimits;
  rationale?: string;
};

/** Safe repo-relative paths of the in-app frames, prefix-stripped, in frame order and without duplicates. */
export function inAppRepoPaths(frames: readonly StackFrame[], pathPrefixes: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of frames) {
    if (!f.inApp) continue;
    const p = toSafeRelPath(stripPathPrefix(f.file, pathPrefixes));
    if (p !== null && !out.includes(p)) out.push(p);
  }
  return out;
}

function result(found: Set<PatchGuardCode>): GuardResult<PatchGuardCode> {
  const violations = PATCH_GUARD_CODES.filter((c) => found.has(c)).map((code) => ({ code, message: MESSAGES[code] }));
  return { ok: violations.length === 0, violations };
}

function sameTestPath(path: string, testPath: string): boolean {
  const t = toSafeRelPath(testPath);
  return t !== null && t.toLowerCase() === path.toLowerCase();
}

/** 1-based first and last line of the single occurrence of `search`, or null when it is not found exactly once. */
function hunkLines(original: string | null | undefined, search: string): { start: number; end: number } | null {
  if (typeof original !== "string") return null;
  const text = normalizeEol(original);
  const needle = normalizeEol(search);
  const hits = findOccurrences(text, needle, 2);
  if (hits.length !== 1) return null;
  let start = 1;
  for (let i = 0; i < hits[0]!; i++) if (text.charCodeAt(i) === 10) start++;
  return { start, end: start + Math.max(1, lineCount(needle)) - 1 };
}

/** Collects every violation of the proposed edits at once (decision 10). */
export function checkPatch(edits: readonly PatchEdit[], ctx: PatchGuardContext): GuardResult<PatchGuardCode> {
  const found = new Set<PatchGuardCode>();
  const limits = effectiveLimits(ctx.limits);
  if (edits.length > limits.maxEdits) found.add("too_many_edits");

  const files = new Set<string>();
  let nearAnchor = false;
  let sourceLines = 0;
  for (const edit of edits) {
    const path = toSafeRelPath(edit.path);
    files.add((path ?? edit.path).toLowerCase());
    if (path === null) {
      found.add("path_escape");
    } else {
      if (isDenied(path, ctx.deniedPaths)) found.add("path_denied");
      if (sameTestPath(path, ctx.test.path) || matchesAnyGlob(path, ctx.testGlobs)) found.add("edits_test_file");
      if (!matchesAnyGlob(path, ctx.sourceGlobs)) found.add("not_source_glob");
      if (!ctx.inAppPaths.includes(path)) found.add("edit_outside_frames");
      if (path === ctx.anchor.path) {
        const h = hunkLines(ctx.originals[path], edit.search);
        if (h && h.start <= ctx.anchor.line + ANCHOR_HUNK_WINDOW && h.end >= ctx.anchor.line - ANCHOR_HUNK_WINDOW) nearAnchor = true;
      }
    }

    const counts = countChangedLines(edit.search, edit.replace);
    sourceLines += counts.added + counts.removed;

    const d = diffLines(edit.search, edit.replace);
    if (d.added.some((l) => IMPORT_PATTERNS.some((re) => re.test(l)))) found.add("new_import");
    if (d.added.some((l) => DANGEROUS_PATTERNS.some((re) => re.test(l)))) found.add("dangerous_call");
    const kept = new Set(d.added.map((l) => l.trim()));
    if (d.removed.some((l) => ASSERTION.test(l) && !kept.has(l.trim()))) found.add("assert_removed");
    if (injectionScan(edit.replace).hit) found.add("injection_text");
  }
  if (!nearAnchor) found.add("edit_outside_frames");
  if (typeof ctx.rationale === "string" && injectionScan(ctx.rationale).hit) found.add("injection_text");

  if (files.size + 1 > limits.maxFiles) found.add("too_many_files");
  if (sourceLines > limits.maxSourceLines) found.add("too_many_source_lines");
  if (sourceLines + lineCount(ctx.test.content) > limits.maxTotalLines) found.add("too_many_total_lines");
  return result(found);
}

export type DiffGuardContext = {
  testPath: string;
  /** The source paths the applied edits touched. */
  editedPaths: readonly string[];
  sourceGlobs: readonly string[];
  testGlobs: readonly string[];
  deniedPaths: readonly string[];
  limits: SizeLimits;
  /** `git status --porcelain=v1 -z` entries; null when the status could not be parsed (fails closed). */
  status?: readonly StatusEntry[] | null;
};

type DiffGuardFile = WorkspaceChange & { modeChange?: boolean };

/** Re-runs the size, path and file-kind rules on the real staged diff (decision 11). */
export function checkDiff(files: readonly DiffGuardFile[], ctx: DiffGuardContext): GuardResult<PatchGuardCode> {
  const found = new Set<PatchGuardCode>();
  const limits = effectiveLimits(ctx.limits);
  const edited = new Set(ctx.editedPaths);
  const seen = new Set<string>();
  let sourceLines = 0;
  let totalLines = 0;

  for (const f of files) {
    seen.add(f.path);
    if (f.kind === "deleted") found.add("delete_file");
    if (f.kind === "renamed") found.add("rename_file");
    if (f.kind === "mode_changed" || f.modeChange === true) found.add("mode_change");
    if (f.kind === "other") found.add("unexpected_file");
    if (f.binary) found.add("binary");
    if (f.symlink) found.add("symlink");
    totalLines += f.added + f.removed;

    const path = toSafeRelPath(f.path);
    if (path === null) {
      found.add("path_escape");
      found.add("unexpected_file");
      continue;
    }
    if (isDenied(path, ctx.deniedPaths)) found.add("path_denied");
    if (path === ctx.testPath) {
      if (f.kind !== "added") found.add("unexpected_file");
      if (!matchesAnyGlob(path, ctx.testGlobs) || matchesAnyGlob(path, ctx.sourceGlobs)) found.add("test_path_not_test");
      continue;
    }
    sourceLines += f.added + f.removed;
    if (!edited.has(path) || f.kind !== "modified") found.add("unexpected_file");
    if (matchesAnyGlob(path, ctx.testGlobs)) found.add("edits_test_file");
    if (!matchesAnyGlob(path, ctx.sourceGlobs)) found.add("not_source_glob");
  }
  if (!seen.has(ctx.testPath)) found.add("unexpected_file");
  for (const p of edited) if (!seen.has(p)) found.add("unexpected_file");

  if (ctx.status !== undefined) {
    if (ctx.status === null) {
      found.add("unexpected_file");
    } else {
      const listed = new Set<string>();
      for (const s of ctx.status) {
        listed.add(s.path);
        const expected = s.path === ctx.testPath ? "A " : edited.has(s.path) ? "M " : null;
        if (expected === null || s.code !== expected || s.oldPath !== null) found.add("unexpected_file");
      }
      if (!listed.has(ctx.testPath)) found.add("unexpected_file");
      for (const p of edited) if (!listed.has(p)) found.add("unexpected_file");
    }
  }

  if (files.length > limits.maxFiles) found.add("too_many_files");
  if (sourceLines > limits.maxSourceLines) found.add("too_many_source_lines");
  if (totalLines > limits.maxTotalLines) found.add("too_many_total_lines");
  return result(found);
}
