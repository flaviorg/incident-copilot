// Parsers for the staged diff the work tree produced (spec 009, decision 11; AC-71): `git diff --cached --numstat -z`,
// the patch's per-file headers and `git status --porcelain=v1 -z`. Anything they cannot read fails closed: a malformed
// numstat or status is null, and a numstat path with no readable header gets kind "other". Pure: no node imports.
import type { WorkspaceChange } from "./ports.ts";

export type NumstatEntry = { path: string; oldPath: string | null; added: number; removed: number; binary: boolean };

export type PatchHeader = {
  path: string;
  oldPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed" | "copied";
  binary: boolean;
  /** Mode 120000 on either side. */
  symlink: boolean;
  modeChange: boolean;
  oldMode: string | null;
  newMode: string | null;
};

/** A changed file, structurally a `WorkspaceChange` plus the rename source and the mode-change flag. */
export type DiffFile = WorkspaceChange & { oldPath: string | null; modeChange: boolean };

export type StatusEntry = { code: string; path: string; oldPath: string | null };

const COUNT = /^\d{1,9}$/;

/**
 * `git diff --numstat -z`: `added\tremoved\tpath\0`, or for a rename or copy `added\tremoved\t\0old\0new\0`. A binary
 * file has `-` counts (reported as 0 with `binary: true`). Null when the input is malformed.
 */
export function parseNumstatZ(text: string): NumstatEntry[] | null {
  if (typeof text !== "string") return null;
  if (text.length === 0) return [];
  if (!text.endsWith("\u0000")) return null;
  const fields = text.slice(0, -1).split("\u0000");
  const out: NumstatEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    const t1 = f.indexOf("\t");
    const t2 = t1 < 0 ? -1 : f.indexOf("\t", t1 + 1);
    if (t1 < 0 || t2 < 0) return null;
    const a = f.slice(0, t1);
    const r = f.slice(t1 + 1, t2);
    const rest = f.slice(t2 + 1);
    const binary = a === "-" && r === "-";
    if (!binary && !(COUNT.test(a) && COUNT.test(r))) return null;
    let path = rest;
    let oldPath: string | null = null;
    if (rest.length === 0) {
      const from = fields[i + 1];
      const to = fields[i + 2];
      if (from === undefined || to === undefined || from.length === 0 || to.length === 0) return null;
      oldPath = from;
      path = to;
      i += 2;
    }
    out.push({ path, oldPath, added: binary ? 0 : Number(a), removed: binary ? 0 : Number(r), binary });
  }
  return out;
}

function stripSide(p: string, side: "a/" | "b/"): string | null {
  if (p.startsWith('"')) return null; // quoted (special characters): not read, fails closed
  return p.startsWith(side) ? p.slice(2) : null;
}

/** `diff --git a/<p> b/<p>` with the same unquoted path on both sides. */
function symmetricPath(line: string): string | null {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"') || !rest.startsWith("a/")) return null;
  const body = rest.slice(2);
  if ((body.length - 3) % 2 !== 0) return null;
  const half = (body.length - 3) / 2;
  const left = body.slice(0, half);
  return body.slice(half) === ` b/${left}` && left.length > 0 ? left : null;
}

/** Per-file headers of a unified git patch. Hunk content is never read as a header. */
export function parsePatchHeaders(patch: string): PatchHeader[] {
  const out: PatchHeader[] = [];
  const lines = typeof patch === "string" ? patch.split("\n") : [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.startsWith("diff --git ")) {
      i++;
      continue;
    }
    let path = symmetricPath(line);
    let oldPath: string | null = null;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let minus: string | null = null;
    let plus: string | null = null;
    let status: PatchHeader["status"] = "modified";
    let binary = false;
    let oldMode: string | null = null;
    let newMode: string | null = null;
    let indexMode: string | null = null;
    let inHunk = false;
    i++;
    for (; i < lines.length && !lines[i]!.startsWith("diff --git "); i++) {
      const h = lines[i]!;
      if (inHunk) continue;
      if (h.startsWith("@@")) {
        inHunk = true;
      } else if (h.startsWith("new file mode ")) {
        status = "added";
        newMode = h.slice("new file mode ".length).trim();
      } else if (h.startsWith("deleted file mode ")) {
        status = "deleted";
        oldMode = h.slice("deleted file mode ".length).trim();
      } else if (h.startsWith("old mode ")) {
        oldMode = h.slice("old mode ".length).trim();
      } else if (h.startsWith("new mode ")) {
        newMode = h.slice("new mode ".length).trim();
      } else if (h.startsWith("rename from ")) {
        status = "renamed";
        renameFrom = h.slice("rename from ".length);
      } else if (h.startsWith("rename to ")) {
        status = "renamed";
        renameTo = h.slice("rename to ".length);
      } else if (h.startsWith("copy from ")) {
        status = "copied";
        renameFrom = h.slice("copy from ".length);
      } else if (h.startsWith("copy to ")) {
        status = "copied";
        renameTo = h.slice("copy to ".length);
      } else if (h.startsWith("index ")) {
        const m = /^index [0-9a-f]+\.\.[0-9a-f]+(?: (\d{6}))?$/.exec(h);
        if (m?.[1]) indexMode = m[1];
      } else if (h.startsWith("Binary files ") || h === "GIT binary patch") {
        binary = true;
        if (h === "GIT binary patch") inHunk = true;
      } else if (h.startsWith("--- ")) {
        minus = h === "--- /dev/null" ? null : stripSide(h.slice(4), "a/");
      } else if (h.startsWith("+++ ")) {
        plus = h === "+++ /dev/null" ? null : stripSide(h.slice(4), "b/");
      }
    }
    if (renameTo !== null) {
      if (renameTo.startsWith('"') || renameFrom === null || renameFrom.startsWith('"')) continue;
      path = renameTo;
      oldPath = renameFrom;
    } else if (path === null) {
      path = status === "deleted" ? minus : plus;
    }
    if (path === null) continue;
    const modes = [oldMode, newMode, indexMode];
    out.push({
      path,
      oldPath,
      status,
      binary,
      symlink: modes.includes("120000"),
      modeChange: oldMode !== null && newMode !== null && oldMode !== newMode,
      oldMode,
      newMode: newMode ?? indexMode,
    });
  }
  return out;
}

function kindOf(h: PatchHeader | undefined): WorkspaceChange["kind"] {
  if (!h) return "other";
  if (h.status === "deleted") return "deleted";
  if (h.status === "renamed" || h.status === "copied") return "renamed";
  if (h.modeChange) return "mode_changed";
  return h.status;
}

/** Numstat entries (the counts) merged with the patch headers (the kinds), in numstat order. */
export function parseStagedDiff(numstatZ: string, patch: string): { ok: true; files: DiffFile[] } | { ok: false } {
  const entries = parseNumstatZ(numstatZ);
  if (entries === null) return { ok: false };
  const headers = new Map<string, PatchHeader>();
  for (const h of parsePatchHeaders(patch)) if (!headers.has(h.path)) headers.set(h.path, h);
  const files = entries.map((e): DiffFile => {
    const h = headers.get(e.path);
    return {
      path: e.path,
      oldPath: e.oldPath ?? h?.oldPath ?? null,
      kind: e.oldPath !== null ? "renamed" : kindOf(h),
      added: e.added,
      removed: e.removed,
      binary: e.binary || (h?.binary ?? false),
      symlink: h?.symlink ?? false,
      modeChange: h?.modeChange ?? false,
    };
  });
  return { ok: true, files };
}

/**
 * `git status --porcelain=v1 -z`: `XY path\0`, and for a rename or copy `XY new\0old\0`. Null when malformed.
 */
export function parsePorcelainZ(text: string): StatusEntry[] | null {
  if (typeof text !== "string") return null;
  if (text.length === 0) return [];
  if (!text.endsWith("\u0000")) return null;
  const fields = text.slice(0, -1).split("\u0000");
  const out: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.length < 4 || f[2] !== " ") return null;
    const code = f.slice(0, 2);
    if (!/^[ MADRCUT?!]{2}$/.test(code)) return null;
    const path = f.slice(3);
    let oldPath: string | null = null;
    if (code.includes("R") || code.includes("C")) {
      const from = fields[i + 1];
      if (from === undefined || from.length === 0) return null;
      oldPath = from;
      i++;
    }
    out.push({ code, path, oldPath });
  }
  return out;
}
