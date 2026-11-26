// Code fixer location rules (spec 009, decision 5): anchor frame, frame-to-repo-path mapping, commit candidate and the
// "new in the failing release" check. Inputs come from connector data only, never from LLM output. Pure: no node imports.
import type { DeployRecord, ReleaseCommit, StackFrame } from "../../contracts/index.ts";
import { isDenied, matchesAnyGlob, toSafeRelPath } from "./paths.ts";

/** The slice of a repository's config the mapping needs. */
export type FrameRepoConfig = {
  pathPrefixes: readonly string[];
  sourceGlobs: readonly string[];
  /** Added to `BUILT_IN_DENIED`. */
  deniedPaths: readonly string[];
};

export type FrameMapping =
  | { ok: true; path: string }
  | { ok: false; reason: "no_in_app_frame" | "path_not_allowlisted" | "path_denied" };

export type AnchorLocation =
  | { ok: true; path: string; frame: StackFrame }
  | { ok: false; reason: "no_in_app_frame" | "path_not_allowlisted" | "path_denied" };

export const SOURCE_EXTENSIONS: readonly string[] = Object.freeze([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
const GENERATED_SEGMENTS: readonly string[] = Object.freeze(["node_modules", "dist", "build"]);
const SHA40 = /^[0-9a-f]{40}$/i;
const MARGIN_MS = 5 * 60 * 1000;

/** The innermost in-app frame (frames are ordered innermost last), or null. */
export function anchorFrame(frames: readonly StackFrame[]): StackFrame | null {
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i]!.inApp) return frames[i]!;
  }
  return null;
}

/** Strips the first configured prefix the file starts with; a file with no matching prefix is returned unchanged. */
export function stripPathPrefix(file: string, prefixes: readonly string[]): string {
  for (const prefix of prefixes) {
    if (prefix.length > 0 && file.startsWith(prefix)) return file.slice(prefix.length);
  }
  return file;
}

/**
 * Maps one in-app frame to a safe repo-relative source path: prefix-stripped, POSIX, no `..`, absolute or Windows
 * path, no `node_modules`, `dist` or `build` segment, no `.min.`, a source extension, inside `sourceGlobs` and outside
 * every denied path.
 */
export function mapFrameToRepoPath(frame: StackFrame | null | undefined, cfg: FrameRepoConfig): FrameMapping {
  if (!frame || !frame.inApp) return { ok: false, reason: "no_in_app_frame" };
  const path = toSafeRelPath(stripPathPrefix(frame.file, cfg.pathPrefixes));
  if (path === null) return { ok: false, reason: "path_not_allowlisted" };
  const segments = path.split("/");
  if (segments.some((s) => GENERATED_SEGMENTS.includes(s.toLowerCase()) || s.toLowerCase().includes(".min."))) {
    return { ok: false, reason: "path_not_allowlisted" };
  }
  if (!SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext))) return { ok: false, reason: "path_not_allowlisted" };
  if (!matchesAnyGlob(path, cfg.sourceGlobs)) return { ok: false, reason: "path_not_allowlisted" };
  if (isDenied(path, cfg.deniedPaths)) return { ok: false, reason: "path_denied" };
  return { ok: true, path };
}

/** The anchor of an event: only the innermost in-app frame is considered, with no fallback to an outer frame. */
export function locateAnchor(frames: readonly StackFrame[], cfg: FrameRepoConfig): AnchorLocation {
  const frame = anchorFrame(frames);
  const mapped = mapFrameToRepoPath(frame, cfg);
  if (!mapped.ok) return mapped;
  return { ok: true, path: mapped.path, frame: frame! };
}

export type CommitCandidate =
  | { ok: true; sha: string; source: "release_commit" | "version" }
  | { ok: false; reason: "commit_unresolved" };

/**
 * Decision 5: the release's `lastCommit.id` when it is 40 hex and its repository equals the allowlisted `owner/name`;
 * else the release version, or its part after the last `@`, when it is 40 hex; else `commit_unresolved`. The caller
 * still confirms the SHA with `CodeHostReader.commitExists`.
 */
export function resolveCommitCandidate(
  releaseCommit: ReleaseCommit | null | undefined,
  version: string | null | undefined,
  repo: string,
): CommitCandidate {
  if (releaseCommit && SHA40.test(releaseCommit.sha) && releaseCommit.repository !== null && releaseCommit.repository === repo) {
    return { ok: true, sha: releaseCommit.sha.toLowerCase(), source: "release_commit" };
  }
  if (typeof version === "string" && version.length > 0) {
    if (SHA40.test(version)) return { ok: true, sha: version.toLowerCase(), source: "version" };
    const at = version.lastIndexOf("@");
    if (at >= 0) {
      const tail = version.slice(at + 1);
      if (SHA40.test(tail)) return { ok: true, sha: tail.toLowerCase(), source: "version" };
    }
  }
  return { ok: false, reason: "commit_unresolved" };
}

/**
 * Decision 5: the matching deploy is the newest one with the failing release's version and `at <= alertStartedAt + 5
 * min`; the error group's `firstSeen` must be `>= deploy.at - 5 min`. A null release or `firstSeen`, no matching deploy
 * or an unparsable time all fail closed (false).
 */
export function isNewInRelease(
  deploys: readonly DeployRecord[],
  release: string | null | undefined,
  firstSeen: string | null | undefined,
  alertStartedAt: string,
): boolean {
  if (!release || !firstSeen) return false;
  const seen = Date.parse(firstSeen);
  const started = Date.parse(alertStartedAt);
  if (!Number.isFinite(seen) || !Number.isFinite(started)) return false;
  let newest: number | null = null;
  for (const d of deploys) {
    if (d.version !== release) continue;
    const at = Date.parse(d.at);
    if (!Number.isFinite(at) || at > started + MARGIN_MS) continue;
    if (newest === null || at > newest) newest = at;
  }
  if (newest === null) return false;
  return seen >= newest - MARGIN_MS;
}
