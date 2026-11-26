// Spec 009, decision 7 (AC-65, AC-79): runs the target repository's tests in a child under the Node permission model.
// No shell, an allowlisted environment, a detached process group that a timeout or an abort kills as a whole, the kit
// reporter's prefixed lines kept apart from the capped output tail, and every text redacted before it leaves.
import { spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { CodeFixIsolation, TestRunSummary } from "../../contracts/index.ts";
import type { SandboxRunInput, SandboxRunResult, SandboxRunner } from "../../domain/code-fix/ports.ts";
import { redactSecrets } from "../redact.ts";
import {
  SANDBOX_REPORT_PREFIX,
  buildSandboxArgv,
  buildSandboxEnv,
  parseReport,
  parseReportLines,
  sandboxPaths,
  type ReportedTest,
} from "./sandbox-argv.ts";

/** The kit sources, copied into `<attempt>/kit/` before every run. */
export const KIT_SOURCE_DIR = fileURLToPath(new URL("./kit/", import.meta.url));
export const KIT_FILES = ["preload.ts", "reporter.ts"] as const;

/** Report lines are kept apart from the tail; past this the report is incomplete and the run is an error. */
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
/** A non-report line longer than this goes to the tail without waiting for its newline. */
const MAX_PENDING_LINE = 64 * 1024;
/** How long the pipes may stay open after the leader exits before the run is ended as an error. */
const PIPE_GRACE_MS = 2000;

export type ProcessSandboxOptions = {
  /** The attempt root, holding `repo/` (cwd and read grant), `kit/` and `tmp/` (the only write grant). */
  attemptDir: string;
  network: CodeFixIsolation;
  /** Cap for the stdout and stderr tail together (`limits.maxOutputBytes`). */
  maxOutputBytes: number;
  /** Every known secret; the output tail and the report are redacted with them. */
  secrets: readonly string[];
  /** Test-only modules imported before the preload (and read-granted). Config cannot set this. */
  extraImports?: readonly string[];
  unsharePath?: string;
  execPath?: string;
  /** Default true; only the self-test's raw OS phase runs without the preload. */
  preload?: boolean;
};

export type DetailedRun = { result: SandboxRunResult; tests: ReportedTest[] };

/** Keeps the last `max` bytes; once anything was dropped, the first partial line goes too. */
class OutputTail {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private truncated = false;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }

  push(buf: Buffer): void {
    if (buf.length === 0) return;
    this.chunks.push(buf);
    this.bytes += buf.length;
    while (this.bytes > this.max) {
      const first = this.chunks[0]!;
      const excess = this.bytes - this.max;
      this.truncated = true;
      if (first.length <= excess) {
        this.chunks.shift();
        this.bytes -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.bytes -= excess;
      }
    }
  }

  /** Redacted, then cut again to the byte cap at a line boundary, so a secret cut at the head never leaks a suffix. */
  text(secrets: readonly string[]): string {
    let text = Buffer.concat(this.chunks).toString("utf8");
    if (this.truncated) text = dropFirstLine(text);
    text = redactSecrets(text, secrets);
    const buf = Buffer.from(text, "utf8");
    if (buf.length <= this.max) return text;
    return dropFirstLine(buf.subarray(buf.length - this.max).toString("utf8"));
  }
}

function dropFirstLine(text: string): string {
  const nl = text.indexOf("\n");
  return nl >= 0 ? text.slice(nl + 1) : text.replace(/^�+/, "");
}

function emptySummary(outcome: TestRunSummary["outcome"], durationMs: number): TestRunSummary {
  return { outcome, exitCode: null, total: 0, passed: 0, failed: 0, skipped: 0, todo: 0, cancelled: 0, durationMs, failures: [] };
}

export class ProcessSandboxRunner implements SandboxRunner {
  private readonly opts: ProcessSandboxOptions;

  constructor(opts: ProcessSandboxOptions) {
    this.opts = opts;
  }

  async run(input: SandboxRunInput): Promise<SandboxRunResult> {
    return (await this.runDetailed(input)).result;
  }

  /** Never throws: a crashing, hanging or unspawnable suite is a result. */
  async runDetailed(input: SandboxRunInput): Promise<DetailedRun> {
    const started = Date.now();
    const secrets = this.opts.secrets;
    const errorRun = (note: string): DetailedRun => ({
      result: { ...emptySummary("error", Date.now() - started), outputTail: redactSecrets(note, secrets) },
      tests: [],
    });
    const execPath = this.opts.execPath ?? process.execPath;
    let argv: string[];
    try {
      argv = buildSandboxArgv({
        execPath,
        attemptDir: this.opts.attemptDir,
        files: input.files,
        network: this.opts.network,
        extraImports: this.opts.extraImports ?? [],
        ...(this.opts.unsharePath !== undefined ? { unsharePath: this.opts.unsharePath } : {}),
        ...(this.opts.preload === false ? { preload: false } : {}),
      });
    } catch {
      return errorRun("sandbox: refused the test file arguments");
    }
    if (input.signal.aborted) return errorRun("sandbox: aborted before start");
    const paths = sandboxPaths(this.opts.attemptDir);
    try {
      await mkdir(paths.kit, { recursive: true });
      await mkdir(paths.tmp, { recursive: true });
      for (const f of KIT_FILES) await copyFile(KIT_SOURCE_DIR + f, `${paths.kit}/${f}`);
    } catch {
      return errorRun("sandbox: could not prepare the kit");
    }
    return await this.spawnAndCollect(argv, input, started, paths.repo);
  }

  private spawnAndCollect(argv: string[], input: SandboxRunInput, started: number, repoDir: string): Promise<DetailedRun> {
    const secrets = this.opts.secrets;
    const env = buildSandboxEnv({ execPath: this.opts.execPath ?? process.execPath, attemptDir: this.opts.attemptDir });
    const tail = new OutputTail(this.opts.maxOutputBytes);
    const report: string[] = [];
    let reportBytes = 0;
    let reportOverflow = false;
    let pending = "";
    const decoder = new StringDecoder("utf8");

    const takeLine = (line: string): void => {
      if (line.startsWith(SANDBOX_REPORT_PREFIX)) {
        reportBytes += Buffer.byteLength(line) + 1;
        if (reportBytes > MAX_REPORT_BYTES) reportOverflow = true;
        else report.push(line);
      } else {
        tail.push(Buffer.from(line + "\n", "utf8"));
      }
    };
    const onStdout = (text: string): void => {
      pending += text;
      let nl = pending.indexOf("\n");
      while (nl >= 0) {
        takeLine(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf("\n");
      }
      if (pending.length > MAX_PENDING_LINE) {
        // An overlong line: report lines are never this long, so it is plain output (or a forged, broken record).
        if (!pending.startsWith(SANDBOX_REPORT_PREFIX)) tail.push(Buffer.from(pending, "utf8"));
        else reportOverflow = true;
        pending = "";
      }
    };

    return new Promise<DetailedRun>((resolve) => {
      let timedOut = false;
      let aborted = false;
      let spawnFailed = false;
      let pipesHeld = false;
      let settled = false;
      let graceTimer: NodeJS.Timeout | null = null;
      const child = spawn(argv[0]!, argv.slice(1), {
        shell: false,
        cwd: repoDir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      const killGroup = (): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group is already gone.
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, Math.max(1, input.timeoutSec) * 1000);
      const onAbort = (): void => {
        aborted = true;
        killGroup();
      };
      input.signal.addEventListener("abort", onAbort, { once: true });

      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        input.signal.removeEventListener("abort", onAbort);
        // Anything left in the group (the leader is gone) is killed too.
        killGroup();
        const rest = decoder.end();
        if (rest) onStdout(rest);
        if (pending.length > 0) takeLine(pending);
        pending = "";
        const durationMs = Date.now() - started;
        const outputTail = tail.text(secrets);
        if (spawnFailed) {
          resolve({ result: { ...emptySummary("error", durationMs), outputTail }, tests: [] });
          return;
        }
        // Redact the raw records before parsing, so clipping can never keep half a secret.
        const reportText = redactSecrets(report.join("\n"), secrets);
        const exitCode = signal !== null ? null : code;
        const parsed = parseReport(reportText, exitCode, { repoRoot: repoDir, durationMs });
        let summary: TestRunSummary = parsed;
        if (timedOut) summary = { ...parsed, outcome: "timeout", exitCode: null };
        else if (aborted || reportOverflow || pipesHeld) summary = { ...parsed, outcome: "error", exitCode: aborted ? null : parsed.exitCode };
        const tests = parseReportLines(reportText, repoDir).tests;
        resolve({ result: { ...redactSecrets(summary, secrets), outputTail }, tests: redactSecrets(tests, secrets) });
      };

      child.stdout.on("data", (buf: Buffer) => onStdout(decoder.write(buf)));
      child.stderr.on("data", (buf: Buffer) => tail.push(buf));
      child.stdout.on("error", () => {});
      child.stderr.on("error", () => {});
      child.once("error", () => {
        spawnFailed = true;
        if (child.pid === undefined) finish(null, null);
      });
      child.once("close", (code, signal) => finish(code, signal));
      // The leader exited but something outside its group still holds the pipes: do not wait for it, and do not
      // trust the run.
      child.once("exit", (code, signal) => {
        graceTimer = setTimeout(() => {
          pipesHeld = true;
          child.stdout.destroy();
          child.stderr.destroy();
          finish(code, signal);
        }, PIPE_GRACE_MS);
      });
    });
  }
}
