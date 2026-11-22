// Repository conventions shown to the fixer's model calls (spec 009, decision 6). Read-only, through the Workspace port:
// regular files only (the port's readFile uses lstat), sanitized as untrusted text and clipped to 24,000 characters in
// total. package.json contributes `type` and `scripts.test` as data only; nothing here chooses a path, command or commit.
import type { Workspace } from "../../domain/code-fix/ports.ts";
import { neutralizeDelimiters } from "../../domain/ingest/sanitize.ts";

export const CONVENTIONS_BUDGET_CHARS = 24_000;
export const ANCHOR_WINDOW_LINES = 60;
export const NEAREST_TESTS = 2;

export type ConventionsFileKind = "anchor_window" | "nearest_test" | "package_json" | "agents" | "contributing";

export type ConventionsFile = {
  kind: ConventionsFileKind;
  path: string;
  /** Sanitized, possibly clipped, untrusted text. */
  text: string;
  /** 1-based line range of the anchor window; null for whole files. */
  startLine: number | null;
  endLine: number | null;
};

export type Conventions = {
  files: ConventionsFile[];
  totalChars: number;
  /** True when any file was clipped or left out because of the budget. */
  truncated: boolean;
};

export type ReadConventionsInput = {
  anchor: { path: string; line: number };
  testGlobs: readonly string[];
  budgetChars?: number;
};

// Per-file caps, applied before the shared budget; listed in priority order.
const CAP = { anchor_window: 9_000, nearest_test: 5_000, package_json: 600, agents: 4_000, contributing: 3_000 } as const;

// C0 controls except \t and \n, DEL, C1 controls, zero-width and bidi override characters (as in sanitizeText).
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** Like sanitizeText, but keeps indentation and line structure, since the text is code or Markdown. */
export function sanitizeRepoText(text: string): string {
  return neutralizeDelimiters(text.replace(/\r\n?/g, "\n").replace(CONTROL, ""));
}

function clip(text: string, max: number): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  return { text: max <= 0 ? "" : text.slice(0, max - 1) + "…", clipped: true };
}

/** Directory distance between two repo paths: steps up from one file's folder plus steps down to the other's. */
export function pathDistance(a: string, b: string): number {
  const da = a.split("/").slice(0, -1);
  const db = b.split("/").slice(0, -1);
  let common = 0;
  while (common < da.length && common < db.length && da[common] === db[common]) common++;
  return da.length - common + (db.length - common);
}

function packageData(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const pkg = parsed as Record<string, unknown>;
  const out: { type?: string; scripts?: { test: string } } = {};
  if (typeof pkg.type === "string") out.type = pkg.type.slice(0, 20);
  const scripts = pkg.scripts;
  if (scripts && typeof scripts === "object" && typeof (scripts as Record<string, unknown>).test === "string") {
    out.scripts = { test: ((scripts as Record<string, unknown>).test as string).slice(0, 300) };
  }
  return JSON.stringify(out);
}

export async function readConventions(ws: Workspace, input: ReadConventionsInput): Promise<Conventions> {
  const budget = Math.min(input.budgetChars ?? CONVENTIONS_BUDGET_CHARS, CONVENTIONS_BUDGET_CHARS);
  const candidates: { kind: ConventionsFileKind; path: string; text: string; startLine: number | null; endLine: number | null }[] = [];

  const anchorText = await ws.readFile(input.anchor.path);
  if (anchorText !== null) {
    const lines = anchorText.split("\n");
    const start = Math.max(1, input.anchor.line - ANCHOR_WINDOW_LINES);
    const end = Math.min(lines.length, input.anchor.line + ANCHOR_WINDOW_LINES);
    const text = lines.slice(start - 1, end).join("\n") + (end < lines.length ? "\n" : "");
    candidates.push({ kind: "anchor_window", path: input.anchor.path, text, startLine: start, endLine: end });
  }

  const tests = (await ws.listFiles(input.testGlobs))
    .filter((p) => p !== input.anchor.path)
    .map((p) => ({ p, d: pathDistance(input.anchor.path, p) }))
    .sort((x, y) => x.d - y.d || (x.p < y.p ? -1 : x.p > y.p ? 1 : 0));
  let found = 0;
  for (const { p } of tests) {
    if (found >= NEAREST_TESTS) break;
    const text = await ws.readFile(p);
    if (text === null) continue; // not a regular file
    candidates.push({ kind: "nearest_test", path: p, text, startLine: null, endLine: null });
    found++;
  }

  const pkgText = await ws.readFile("package.json");
  const pkg = pkgText === null ? null : packageData(pkgText);
  if (pkg !== null) candidates.push({ kind: "package_json", path: "package.json", text: pkg, startLine: null, endLine: null });

  for (const [kind, path] of [["agents", "AGENTS.md"], ["contributing", "CONTRIBUTING.md"]] as const) {
    const text = await ws.readFile(path);
    if (text !== null) candidates.push({ kind, path, text, startLine: null, endLine: null });
  }

  const files: ConventionsFile[] = [];
  let total = 0;
  let truncated = false;
  for (const c of candidates) {
    const capped = clip(sanitizeRepoText(c.text), CAP[c.kind]);
    const remaining = budget - total;
    if (remaining <= 0) {
      truncated = true;
      continue;
    }
    const fitted = clip(capped.text, remaining);
    truncated ||= capped.clipped || fitted.clipped;
    if (fitted.text === "") continue;
    files.push({ ...c, text: fitted.text });
    total += fitted.text.length;
  }
  return { files, totalChars: total, truncated };
}
