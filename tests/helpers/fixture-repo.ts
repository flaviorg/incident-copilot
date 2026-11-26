// Builds a throwaway Git repository from a fixture folder under tests/fixtures/repos/<name> (spec 009, decision 6; AC-64).
// The copy lives in mkdtemp(realpath(tmpdir())/ic-fixrepo-), is committed with a fixed author and date and with the host's
// global and system Git config ignored, and is exposed through a bare clone at a file:// URL. No network.
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export const FIXTURE_REPOS_DIR = fileURLToPath(new URL("../fixtures/repos/", import.meta.url));

/** File content, a symlink (committed as mode 120000) or null to delete the path. */
export type FixtureFile = string | { symlink: string } | null;
export type FixtureFiles = Readonly<Record<string, FixtureFile>>;

export type FixtureRepo = {
  /** mkdtemp root holding `work/` and `bare.git`. */
  readonly root: string;
  readonly workDir: string;
  readonly bareDir: string;
  /** file:// URL of the bare clone. */
  readonly bareUrl: string;
  /** The first commit: the fixture as it ships, plus overrides. */
  readonly releaseSha: string;
  /** The current head of `main` in the bare clone; updated by `commit`. */
  readonly headSha: string;
  /** Commits the files on `main`, pushes to the bare clone and returns the new head. */
  commit(files: FixtureFiles, message?: string): Promise<string>;
  cleanup(): Promise<void>;
};

export type CreateFixtureRepoOptions = {
  /** Applied to the copy before the release commit (used to plant hostile files). */
  overrides?: FixtureFiles;
};

const FIXED_DATE = "2026-01-15T12:00:00Z";
let tick = 0;

/** A child env with no inherited Git or HOME settings, a fixed identity and a fixed (monotonic) date. */
function gitEnv(): Record<string, string> {
  const date = new Date(Date.parse(FIXED_DATE) + 60_000 * tick++).toISOString();
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fixture Author",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: "Fixture Author",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_DATE: date,
  };
}

const SAFE_FLAGS = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "core.symlinks=true"];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", [...SAFE_FLAGS, ...args], { cwd, env: gitEnv(), encoding: "utf8", timeout: 30_000 });
  return stdout.trim();
}

async function applyFiles(dir: string, files: FixtureFiles): Promise<void> {
  for (const [rel, value] of Object.entries(files)) {
    if (rel.startsWith("/") || rel.split("/").includes("..")) throw new Error(`unsafe fixture path: ${rel}`);
    const full = join(dir, rel);
    await rm(full, { force: true, recursive: true });
    if (value === null) continue;
    await mkdir(dirname(full), { recursive: true });
    if (typeof value === "string") await writeFile(full, value);
    else await symlink(value.symlink, full);
  }
}

export async function createFixtureRepo(name: string, opts: CreateFixtureRepoOptions = {}): Promise<FixtureRepo> {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid fixture name: ${name}`);
  const root = await mkdtemp(join(await realpath(tmpdir()), "ic-fixrepo-"));
  const workDir = join(root, "work");
  const bareDir = join(root, "bare.git");
  try {
    await cp(join(FIXTURE_REPOS_DIR, name), workDir, { recursive: true, verbatimSymlinks: true });
    if (opts.overrides) await applyFiles(workDir, opts.overrides);
    await git(workDir, ["init", "--quiet", "--template=", "-b", "main"]);
    await git(workDir, ["add", "-A"]);
    await git(workDir, ["commit", "--quiet", "--no-verify", "-m", "release"]);
    const releaseSha = await git(workDir, ["rev-parse", "HEAD"]);
    await git(root, ["clone", "--quiet", "--bare", "--template=", workDir, bareDir]);
    await git(workDir, ["remote", "add", "origin", bareDir]);
    let headSha = releaseSha;
    return {
      root,
      workDir,
      bareDir,
      bareUrl: pathToFileURL(bareDir).href,
      releaseSha,
      get headSha() {
        return headSha;
      },
      async commit(files, message = "change") {
        await applyFiles(workDir, files);
        await git(workDir, ["add", "-A"]);
        await git(workDir, ["commit", "--quiet", "--no-verify", "--allow-empty", "-m", message]);
        await git(workDir, ["push", "--quiet", "origin", "main"]);
        headSha = await git(workDir, ["rev-parse", "HEAD"]);
        return headSha;
      },
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(root, { recursive: true, force: true });
    throw err;
  }
}
