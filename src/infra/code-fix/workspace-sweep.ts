// Spec 009, decisions 2 and 6 (AC-64): attempt directories left behind by a process that died before its attempt
// ended (a crash, an OOM kill, a SIGKILL at the stop grace). Each one holds a checkout of an allowlisted, possibly
// private, repository plus the model-written test and patch; on start they are removed before any attempt runs.
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

/** Exactly what `mkdtemp(<root>/ic-fix-)` creates (six random characters); the self-test's base is not matched. */
const ATTEMPT_DIR = /^ic-fix-[A-Za-z0-9]{6}$/;

export type SweepStaleWorkspacesInput = {
  /** The parent of the attempt directories (GitCliWorkspace's tmpRoot, by default os.tmpdir()). */
  root: string;
  /** Epoch ms: only directories last modified before this (this process's start) are removed. */
  createdBefore: number;
};

/**
 * Removes `ic-fix-XXXXXX` directories directly under `root` that are older than `createdBefore`. A symlink or any other
 * entry is left alone and never followed. An entry that cannot be removed is skipped; the count of removed ones is
 * returned. Throws only when `root` itself cannot be read.
 */
export async function sweepStaleWorkspaces(input: SweepStaleWorkspacesInput): Promise<number> {
  const root = await realpath(input.root);
  let removed = 0;
  for (const name of await readdir(root)) {
    if (!ATTEMPT_DIR.test(name)) continue;
    const path = join(root, name);
    try {
      const st = await lstat(path);
      if (!st.isDirectory() || st.isSymbolicLink() || st.mtimeMs >= input.createdBefore) continue;
      await rm(path, { recursive: true, force: true });
      removed++;
    } catch {
      // Gone already, or not ours to remove: the next start tries again.
    }
  }
  return removed;
}
