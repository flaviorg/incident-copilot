// Search-and-replace edits and deterministic line counts (spec 009, decisions 8 and 10; AC-70, AC-71). Each `search`
// must match exactly once. Pure: no node imports.

export type SearchReplace = { search: string; replace: string };
export type FileEdit = SearchReplace & { path: string };

export type ApplyEditsResult =
  | { ok: true; text: string }
  | { ok: false; reason: "edit_not_applicable"; index: number; matches: number };

export type ApplyFileEditsResult =
  | { ok: true; files: { path: string; before: string; after: string }[] }
  | { ok: false; reason: "edit_not_applicable"; path: string; index: number; matches: number };

/** Above this many cells the line diff falls back to an upper bound (every middle line changed). */
const MAX_DIFF_CELLS = 4_000_000;
/** Stands for "this last line has no trailing newline", so that change counts like git's `\ No newline`. */
const NO_EOL = "\u0000no-eol";

export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Start offsets of every occurrence of `search` in `text`, overlapping ones included; at most `limit` of them. */
export function findOccurrences(text: string, search: string, limit = Number.POSITIVE_INFINITY): number[] {
  const out: number[] = [];
  if (search.length === 0) return out;
  let from = 0;
  while (out.length < limit) {
    const i = text.indexOf(search, from);
    if (i < 0) break;
    out.push(i);
    from = i + 1;
  }
  return out;
}

/** Original offset of every offset of `normalizeEol(text)` (one more entry than its length). */
function normalizedOffsets(text: string): number[] {
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    map.push(i);
    if (text[i] === "\r" && text[i + 1] === "\n") i++; // the pair is one "\n", mapped to its "\r"
  }
  map.push(text.length);
  return map;
}

/** The line ending of the line that holds offset `at` (the next one), else the previous one, else `fallback`. */
function eolNear(text: string, at: number, fallback: string): string {
  const next = text.indexOf("\n", at);
  if (next >= 0) return next > 0 && text[next - 1] === "\r" ? "\r\n" : "\n";
  const prev = text.lastIndexOf("\n", at - 1);
  if (prev >= 0) return prev > 0 && text[prev - 1] === "\r" ? "\r\n" : "\n";
  return fallback;
}

/**
 * Applies edits in order, each on the result of the previous one. Matching ignores CRLF versus LF, and every line
 * keeps its own ending: the k-th newline of a replacement takes the k-th ending of the text it replaces, and extra
 * newlines take the last of those (or the ending of the line around the match), so a mixed-EOL file changes only on
 * the edited lines. The trailing-newline state is kept. An empty search, or one that matches zero or several times,
 * gives `edit_not_applicable` with the edit index and the match count.
 */
export function applyEdits(original: string, edits: readonly SearchReplace[]): ApplyEditsResult {
  const endsWithNewline = original.endsWith("\n");
  const fileEol = original.includes("\r\n") && !/(^|[^\r])\n/.test(original) ? "\r\n" : "\n";
  let text = original;
  for (let index = 0; index < edits.length; index++) {
    const search = normalizeEol(edits[index]!.search);
    const replace = normalizeEol(edits[index]!.replace);
    const hits = findOccurrences(normalizeEol(text), search);
    if (hits.length !== 1) return { ok: false, reason: "edit_not_applicable", index, matches: hits.length };
    const map = normalizedOffsets(text);
    const start = map[hits[0]!]!;
    const end = map[hits[0]! + search.length]!;
    const endings = text.slice(start, end).match(/\r?\n/g) ?? [];
    const near = endings.length > 0 ? endings[endings.length - 1]! : eolNear(text, end, fileEol);
    let k = 0;
    const rewritten = replace.replace(/\n/g, () => endings[k++] ?? near);
    text = text.slice(0, start) + rewritten + text.slice(end);
  }
  if (endsWithNewline && !text.endsWith("\n")) text += original.endsWith("\r\n") ? "\r\n" : "\n";
  if (!endsWithNewline) text = text.replace(/(\r?\n)+$/, "");
  return { ok: true, text };
}

/** Groups edits by path (first-seen order) and applies them; a missing original is `edit_not_applicable` (0 matches). */
export function applyEditsToFiles(
  originals: Readonly<Record<string, string | null | undefined>>,
  edits: readonly FileEdit[],
): ApplyFileEditsResult {
  const order: string[] = [];
  const byPath = new Map<string, { edit: FileEdit; index: number }[]>();
  edits.forEach((edit, index) => {
    if (!byPath.has(edit.path)) {
      byPath.set(edit.path, []);
      order.push(edit.path);
    }
    byPath.get(edit.path)!.push({ edit, index });
  });
  const files: { path: string; before: string; after: string }[] = [];
  for (const path of order) {
    const group = byPath.get(path)!;
    const before = Object.prototype.hasOwnProperty.call(originals, path) ? originals[path] : undefined;
    if (typeof before !== "string") return { ok: false, reason: "edit_not_applicable", path, index: group[0]!.index, matches: 0 };
    const r = applyEdits(before, group.map((g) => g.edit));
    if (!r.ok) return { ok: false, reason: "edit_not_applicable", path, index: group[r.index]!.index, matches: r.matches };
    files.push({ path, before, after: r.text });
  }
  return { ok: true, files };
}

/** Lines of a text, CRLF normalized; a trailing newline does not add a line. */
export function lineCount(text: string): number {
  return splitLines(text).length;
}

function splitLines(text: string): string[] {
  const t = normalizeEol(text);
  if (t.length === 0) return [];
  const parts = t.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  else parts[parts.length - 1] += NO_EOL;
  return parts;
}

function clean(line: string): string {
  return line.endsWith(NO_EOL) ? line.slice(0, -NO_EOL.length) : line;
}

/**
 * A minimal line diff (longest common subsequence after trimming the common prefix and suffix), CRLF normalized. When
 * the middle is too large it returns every middle line as changed: an upper bound, never less than the real change.
 */
export function diffLines(before: string, after: string): { added: string[]; removed: string[] } {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length === 0 || midB.length === 0 || midA.length * midB.length > MAX_DIFF_CELLS) {
    return { added: midB.map(clean), removed: midA.map(clean) };
  }
  const n = midA.length;
  const m = midB.length;
  // lcs[i][j] = LCS length of midA[i..] and midB[j..], flattened.
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = midA[i] === midB[j]
        ? lcs[(i + 1) * width + j + 1]! + 1
        : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const added: string[] = [];
  const removed: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      removed.push(clean(midA[i++]!));
    } else {
      added.push(clean(midB[j++]!));
    }
  }
  while (i < n) removed.push(clean(midA[i++]!));
  while (j < m) added.push(clean(midB[j++]!));
  return { added, removed };
}

/** Added and removed line counts of a minimal line diff; deterministic for the same input. */
export function countChangedLines(before: string, after: string): { added: number; removed: number } {
  const d = diffLines(before, after);
  return { added: d.added.length, removed: d.removed.length };
}
