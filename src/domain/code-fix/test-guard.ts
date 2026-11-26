// Deterministic guard over the model-written regression test (spec 009, decision 10; AC-68). It runs before the test
// file is written or run, collects every violation at once and returns fixed English sentences that go back to the test
// author as feedback; a message never echoes more than a token from the fixed lists below, never file content. A
// heuristic floor: the Node permission model, network isolation and human approval are the real controls. Pure.
import type { CodeFixLimits } from "./limits.ts";
import { effectiveLimits } from "./limits.ts";
import { injectionScan } from "./injection-scan.ts";
import { BANNED_CODE_TOKENS, codeBanHits } from "./code-ban.ts";
import { lineCount } from "./edits.ts";
import { isDenied, matchesAnyGlob, toSafeRelPath } from "./paths.ts";

export type GuardViolation<C extends string = string> = { code: C; message: string };
export type GuardResult<C extends string = string> = { ok: boolean; violations: GuardViolation<C>[] };

export const TEST_GUARD_CODES = [
  "path_escape", "test_path_not_test", "path_denied", "test_file_exists", "test_too_large", "test_not_importing_anchor",
  "test_import_not_allowed", "test_banned_token", "skip_marker", "test_no_assert", "trivial_assert", "injection_text",
] as const satisfies readonly string[];
export type TestGuardCode = (typeof TEST_GUARD_CODES)[number];

const MESSAGES: Record<TestGuardCode, string> = {
  path_escape: "The test path must be a plain repo-relative POSIX path with no '..', absolute, Windows or home path.",
  test_path_not_test: "The test path must match the repository's test globs and must not match its source globs.",
  path_denied: "The test path is in a denied location; choose a path outside the denied paths.",
  test_file_exists: "The test file must be new; a file already exists at this path.",
  test_too_large: "The test file is longer than the allowed number of lines.",
  test_not_importing_anchor: "The test must import the module of the failing frame by its relative path.",
  test_import_not_allowed: "The test may import only node:test, node:assert, node:assert/strict and existing relative modules of the repository.",
  test_banned_token: "The test uses a banned token.",
  skip_marker: "The test must not use skip, only or todo markers.",
  test_no_assert: "The test must contain at least one node:assert assertion.",
  trivial_assert: "The test contains an assertion that is trivially true; assert on the result of the code under test.",
  injection_text: "The test or its rationale contains text that addresses the reviewer or the model; remove it.",
};

const ALLOWED_BUILTINS: readonly string[] = Object.freeze(["node:test", "node:assert", "node:assert/strict"]);

/**
 * Banned in model-written test code: in-process results can be forged by code that reaches these (decision 7). The
 * shared list (also used by the patch guard) plus two tokens only a test has no use for. `codeBanHits` adds the
 * escape, non-ASCII and computed-key rules.
 */
export const BANNED_TEST_TOKENS: readonly (readonly [string, RegExp])[] = Object.freeze([
  ...BANNED_CODE_TOKENS,
  ["Proxy", /\bProxy\b/],
  ["setInterval", /\bsetInterval\b/],
] as const);
const TEST_ONLY_TOKENS = BANNED_TEST_TOKENS.slice(BANNED_CODE_TOKENS.length);

const SKIP_MARKERS: readonly RegExp[] = Object.freeze([
  /\.\s*(?:skip|only|todo)\b/,
  /[{,]\s*["']?(?:skip|todo|only)["']?\s*[:,}]/,
]);

const STATIC_IMPORT = /\bimport\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s*\bfrom\s*)?(["'])([^"'\n]+)\1/g;
const EXPORT_FROM = /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(["'])([^"'\n]+)\1/g;
const IMPORT_WORD = /\bimport\b/g;
const ASSERT_CALL = /\bassert(?:\s*\.\s*([A-Za-z]+))?\s*\(/g;

export type TestFileProposal = { path: string; content: string; rationale?: string };

export type TestGuardContext = {
  /** Repo-relative path of the anchor file (from connector data). */
  anchorPath: string;
  sourceGlobs: readonly string[];
  testGlobs: readonly string[];
  /** Added to `BUILT_IN_DENIED`. */
  deniedPaths: readonly string[];
  /** Tracked repo-relative paths at the base head. */
  repoFiles: readonly string[];
  /** Clamped through `effectiveLimits`: config can only lower the ceiling. */
  limits: Partial<Pick<CodeFixLimits, "maxTestLines">>;
};

/** Collects every violation of the proposed test file at once. */
export function checkTestFile(proposal: TestFileProposal, ctx: TestGuardContext): GuardResult<TestGuardCode> {
  const found = new Set<TestGuardCode>();
  const bannedHits: string[] = [];
  const content = typeof proposal.content === "string" ? proposal.content : "";
  const path = toSafeRelPath(proposal.path);
  const limits = effectiveLimits(ctx.limits);

  if (path === null) {
    found.add("path_escape");
  } else {
    if (!matchesAnyGlob(path, ctx.testGlobs) || matchesAnyGlob(path, ctx.sourceGlobs)) found.add("test_path_not_test");
    if (isDenied(path, ctx.deniedPaths)) found.add("path_denied");
    const lower = path.toLowerCase();
    if (ctx.repoFiles.some((f) => f.toLowerCase() === lower)) found.add("test_file_exists");
  }

  if (lineCount(content) > limits.maxTestLines || content.length > 6000) found.add("test_too_large");

  // Imports.
  const repoFiles = new Set(ctx.repoFiles);
  const specifiers = [...matchAll(content, STATIC_IMPORT), ...matchAll(content, EXPORT_FROM)];
  const importWords = (content.match(IMPORT_WORD) ?? []).length;
  if (importWords > matchAll(content, STATIC_IMPORT).length) found.add("test_import_not_allowed");
  let importsAnchor = false;
  for (const spec of specifiers) {
    if (ALLOWED_BUILTINS.includes(spec)) continue;
    if (spec.startsWith("./") || spec.startsWith("../")) {
      const resolved = path === null ? null : resolveRelative(path, spec);
      if (resolved === null || resolved === path || !repoFiles.has(resolved)) {
        found.add("test_import_not_allowed");
        continue;
      }
      if (resolved === ctx.anchorPath) importsAnchor = true;
      continue;
    }
    found.add("test_import_not_allowed");
  }
  if (!importsAnchor) found.add("test_not_importing_anchor");

  bannedHits.push(...codeBanHits(content));
  for (const [token, re] of TEST_ONLY_TOKENS) if (re.test(content)) bannedHits.push(token);
  if (bannedHits.length > 0) found.add("test_banned_token");

  if (SKIP_MARKERS.some((re) => re.test(content))) found.add("skip_marker");

  const asserts = assertionCalls(content);
  if (asserts.length === 0) found.add("test_no_assert");
  if (asserts.some(isTrivial)) found.add("trivial_assert");

  if (injectionScan(content).hit || (typeof proposal.rationale === "string" && injectionScan(proposal.rationale).hit)) {
    found.add("injection_text");
  }

  const violations = TEST_GUARD_CODES.filter((c) => found.has(c)).map((code) => ({
    code,
    message: code === "test_banned_token" ? `The test uses banned tokens: ${bannedHits.join(", ")}.` : MESSAGES[code],
  }));
  return { ok: violations.length === 0, violations };
}

function matchAll(content: string, re: RegExp): string[] {
  return [...content.matchAll(re)].map((m) => m[2]!);
}

/** Resolves a relative specifier against the test file's directory; null when it leaves the repository. */
export function resolveRelative(fromFile: string, specifier: string): string | null {
  const segments = fromFile.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return toSafeRelPath(segments.join("/"));
}

type AssertCall = { method: string; args: string[] };

/** Every `assert(...)` / `assert.x(...)` call with its top-level arguments (source text). */
function assertionCalls(content: string): AssertCall[] {
  const out: AssertCall[] = [];
  for (const m of content.matchAll(ASSERT_CALL)) {
    const open = m.index! + m[0].length - 1;
    const args = splitArgs(content, open);
    out.push({ method: m[1] ?? "ok", args });
  }
  return out;
}

/** Splits the arguments of the call whose `(` is at `open`, honoring nesting and simple string literals. */
function splitArgs(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = open + 1; i < text.length && i < open + 2000; i++) {
    const c = text[i]!;
    if (quote) {
      current += c;
      if (c === "\\") {
        current += text[i + 1] ?? "";
        i++;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      current += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) {
        if (current.trim().length > 0) args.push(current.trim());
        return args;
      }
      depth--;
    }
    if (c === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim().length > 0) args.push(current.trim());
  return args;
}

type Literal = { value: unknown };

function literal(src: string | undefined): Literal | null {
  if (src === undefined) return null;
  let s = src.trim();
  let negations = 0;
  while (s.startsWith("!")) {
    negations++;
    s = s.slice(1).trim();
  }
  let value: unknown;
  if (s === "true") value = true;
  else if (s === "false") value = false;
  else if (s === "null") value = null;
  else if (s === "undefined") value = undefined;
  else if (/^-?\d+(?:\.\d+)?$/.test(s)) value = Number(s);
  else if (/^"[^"\\]*"$|^'[^'\\]*'$|^`[^`\\$]*`$/.test(s)) value = s.slice(1, -1);
  else if (/^\[\s*\]$/.test(s)) value = [];
  else if (/^\{\s*\}$/.test(s)) value = {};
  else return null;
  if (negations > 0) value = negations % 2 === 1 ? !value : Boolean(value);
  return { value };
}

const EQUAL = new Set(["equal", "strictEqual", "deepEqual", "deepStrictEqual"]);
const NOT_EQUAL = new Set(["notEqual", "notStrictEqual", "notDeepEqual", "notDeepStrictEqual"]);

function isTrivial(call: AssertCall): boolean {
  const [a, b] = call.args;
  if (call.method === "ok") {
    const l = literal(a);
    return l !== null && Boolean(l.value);
  }
  if (EQUAL.has(call.method)) {
    if (a === undefined || b === undefined) return false;
    if (a.replace(/\s+/g, "") === b.replace(/\s+/g, "")) return true;
    const la = literal(a);
    const lb = literal(b);
    return la !== null && lb !== null && JSON.stringify(la.value) === JSON.stringify(lb.value);
  }
  if (NOT_EQUAL.has(call.method)) {
    const la = literal(a);
    const lb = literal(b);
    return la !== null && lb !== null && JSON.stringify(la.value) !== JSON.stringify(lb.value);
  }
  return false;
}
