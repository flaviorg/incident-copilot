// Spec 009, decision 7 (AC-66): the startup self-test. It runs the bundled probe through the full runner in a throwaway
// attempt and passes only when every check is proven denied. Phase 1 runs with the preload (environment, child process,
// writes outside tmp/, reads of the copilot's files, the preload's network block). Phase 2 runs without it, so the
// permission model alone must deny child processes and, in `isolated` mode, the OS must block TCP to loopback and to
// the GitHub API host. In `best_effort` mode the network checks are not claimed. Never throws.
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:net";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeFixIsolation } from "../../contracts/index.ts";
import { PROJECT_ROOT, projectPath } from "../paths.ts";
import { KIT_SOURCE_DIR, ProcessSandboxRunner } from "./process-sandbox.ts";
import { RUNTIME_ADDED_ENV_KEYS, SANDBOX_ENV_KEYS, type ReportedTest } from "./sandbox-argv.ts";

export const SELF_TEST_CHECKS = [
  "env_secret_absent",
  "child_process_denied",
  "write_outside_tmp_denied",
  "copilot_read_denied",
  "preload_blocks_network",
  "child_process_denied_os",
  "tcp_loopback_blocked",
  "tcp_github_blocked",
] as const;
export type SelfTestCheckId = (typeof SELF_TEST_CHECKS)[number];

const PRELOAD_PHASE: readonly SelfTestCheckId[] = ["env_secret_absent", "child_process_denied", "write_outside_tmp_denied", "copilot_read_denied", "preload_blocks_network"];
const NETWORK_CHECKS: readonly SelfTestCheckId[] = ["tcp_loopback_blocked", "tcp_github_blocked"];

/** The copilot's own secrets; none may reach the child. */
const COPILOT_SECRET_ENV = ["GITHUB_FIX_TOKEN", "OPENROUTER_API_KEY", "APPROVAL_TOKEN", "API_TOKEN"];
const PLANTED_ENV = "IC_SANDBOX_SELF_TEST_SECRET";
const GITHUB_API_HOST = "api.github.com";

export type SelfTestOptions = {
  network: CodeFixIsolation;
  /** The copilot's config and database paths (default: copilot.yaml, .env and data/ under the project root). */
  readTargets?: readonly string[];
  unsharePath?: string;
  execPath?: string;
  /** Test-only imports, as for the runner. */
  extraImports?: readonly string[];
  timeoutSec?: number;
};

export type SelfTestCheck = { id: SelfTestCheckId; ok: boolean };

export type SelfTestResult = {
  ok: boolean;
  network: CodeFixIsolation;
  checks: SelfTestCheck[];
  /** Ids of the checks that could not be proven. */
  failed: SelfTestCheckId[];
};

function expectedChecks(network: CodeFixIsolation): SelfTestCheckId[] {
  return SELF_TEST_CHECKS.filter((id) => network === "isolated" || !NETWORK_CHECKS.includes(id));
}

/** Only a coherent report counts (passed or failed); an error or a timeout proves nothing. */
function passedNames(outcome: string, tests: readonly ReportedTest[]): Set<string> {
  if (outcome !== "passed" && outcome !== "failed") return new Set();
  return new Set(tests.filter((t) => t.status === "passed").map((t) => t.name));
}

async function listen(): Promise<{ server: Server; port: number } | null> {
  const server = createServer((socket) => socket.destroy());
  return await new Promise((resolve) => {
    server.once("error", () => resolve(null));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(addr && typeof addr === "object" ? { server, port: addr.port } : null);
    });
  });
}

export async function runSandboxSelfTest(opts: SelfTestOptions): Promise<SelfTestResult> {
  const expected = expectedChecks(opts.network);
  const failAll = (): SelfTestResult => ({ ok: false, network: opts.network, checks: expected.map((id) => ({ id, ok: false })), failed: [...expected] });
  let base: string | null = null;
  let listener: { server: Server; port: number } | null = null;
  const previousPlanted = process.env[PLANTED_ENV];
  try {
    base = await mkdtemp(join(await realpath(tmpdir()), "ic-fix-selftest-"));
    const attemptDir = join(base, "attempt");
    const repo = join(attemptDir, "repo");
    const tmp = join(attemptDir, "tmp");
    await mkdir(repo, { recursive: true });
    await mkdir(tmp, { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "sandbox-probe", type: "module", private: true }));
    await copyFile(KIT_SOURCE_DIR + "probe.test.ts", join(repo, "probe.test.ts"));
    // A planted file next to the attempt stands in for copilot.yaml; it exists, so only the sandbox can deny it.
    const plantedFile = join(base, "copilot.yaml");
    await writeFile(plantedFile, "planted: true\n");
    const outsideWrite = join(base, "escaped.txt");
    const readTargets = [...(opts.readTargets ?? [projectPath("copilot.yaml"), projectPath(".env"), projectPath("data")]), plantedFile, join(PROJECT_ROOT, "package.json")];
    const plantedValue = "ic-planted-" + randomBytes(16).toString("hex");
    process.env[PLANTED_ENV] = plantedValue;
    if (opts.network === "isolated") listener = await listen();

    const runPhase = async (phase: "preload" | "os"): Promise<Set<string>> => {
      await writeFile(join(tmp, "probe-config.json"), JSON.stringify({
        phase,
        network: opts.network,
        envKeys: [...SANDBOX_ENV_KEYS, ...RUNTIME_ADDED_ENV_KEYS],
        plantedKey: PLANTED_ENV,
        plantedValue,
        forbiddenEnv: COPILOT_SECRET_ENV,
        readTargets,
        writeTargets: [join(repo, "probe-write.txt"), outsideWrite],
        loopbackPort: listener?.port ?? null,
        githubHost: GITHUB_API_HOST,
      }));
      const runner = new ProcessSandboxRunner({
        attemptDir,
        network: opts.network,
        maxOutputBytes: 16_384,
        secrets: [plantedValue],
        ...(opts.extraImports !== undefined ? { extraImports: opts.extraImports } : {}),
        ...(opts.unsharePath !== undefined ? { unsharePath: opts.unsharePath } : {}),
        ...(opts.execPath !== undefined ? { execPath: opts.execPath } : {}),
        preload: phase === "preload",
      });
      const { result, tests } = await runner.runDetailed({ files: ["probe.test.ts"], timeoutSec: opts.timeoutSec ?? 30, signal: new AbortController().signal });
      return passedNames(result.outcome, tests);
    };

    const preloadPassed = await runPhase("preload");
    const osPassed = await runPhase("os");
    const escaped = existsSync(outsideWrite) || existsSync(join(repo, "probe-write.txt"));
    const checks = expected.map((id): SelfTestCheck => {
      let ok = PRELOAD_PHASE.includes(id) ? preloadPassed.has(id) : osPassed.has(id);
      if (id === "write_outside_tmp_denied" && escaped) ok = false;
      return { id, ok };
    });
    const failed = checks.filter((c) => !c.ok).map((c) => c.id);
    return { ok: failed.length === 0, network: opts.network, checks, failed };
  } catch {
    return failAll();
  } finally {
    if (previousPlanted === undefined) delete process.env[PLANTED_ENV];
    else process.env[PLANTED_ENV] = previousPlanted;
    if (listener) await new Promise<void>((resolve) => listener!.server.close(() => resolve()));
    if (base) await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}
