// In-memory fakes for the code fixer graph (spec 009): connector query, code-host reader, git workspace and sandbox.
// No I/O and no network. Each fake records its calls so tests can assert order and absence ("no locate call").
import type { DeployRecord, ErrorEvent, ReleaseCommit, StackFrame, TestFailure, TestRunSummary } from "../../src/contracts/index.ts";
import { countChangedLines } from "../../src/domain/code-fix/edits.ts";
import { matchesAnyGlob } from "../../src/domain/code-fix/paths.ts";
import type {
  BranchInfo, CodeHostReader, CommitInfo, FileMode, GitRefInfo, GitWorkspacePort, PrepareWorkspaceInput, PullRequestInfo, RepoRef,
  SandboxRunInput, SandboxRunner, SandboxRunResult, StagedDiff, Workspace, WorkspaceChange,
} from "../../src/domain/code-fix/ports.ts";
import { initialCodeFixState } from "../../src/graph/code-fix/state.ts";
import type { CodeFixRepoConfig, CodeFixState, FixConnectorQuery } from "../../src/graph/code-fix/state.ts";

// ---------- sample facts (aligned with tests/fixtures/connectors/sentry) ----------

export const SHA_RELEASE = "3f786850e387550fdab836ed7e6dc881de23001b";
export const SHA_HEAD = "b".repeat(40);
export const RELEASE = "checkout-web@2026.10.04-1";
export const ANCHOR_PATH = "src/checkout/cart-summary.ts";
export const ANCHOR_LINE = 27;
export const ALERT_STARTED_AT = "2026-10-04T09:50:00.000Z";

export const SAMPLE_REPO: CodeFixRepoConfig = {
  repo: "acme/checkout-web",
  service: "checkout-web",
  connector: "sentry",
  baseBranch: "main",
  pathPrefixes: ["/srv/app/", "app:///"],
  sourceGlobs: ["src/**/*.{js,ts}"],
  testGlobs: ["tests/**/*.test.{js,ts}"],
  testFiles: ["tests/**/*.test.ts"],
  deniedPaths: ["src/pricing/**"],
};

export function frame(file: string, line: number, inApp = true, fn: string | null = "fn"): StackFrame {
  return { file, line, column: 3, function: fn, inApp };
}

/** Innermost last, as Sentry reports them. */
export function sampleErrorEvent(over: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    errorId: "4815162342",
    release: RELEASE,
    firstSeen: "2026-10-04T09:41:30.000Z",
    exception: { type: "TypeError", value: "Cannot read properties of undefined (reading 'total')" },
    frames: [
      frame("node:internal/process/task_queues", 95, false, "processTicksAndRejections"),
      frame("/srv/app/src/checkout/routes.ts", 41, true, "handleCheckout"),
      frame(ANCHOR_PATH, ANCHOR_LINE, true, "summarize"),
    ],
    ...over,
  };
}

export function sampleDeploys(): DeployRecord[] {
  return [
    { version: "checkout-web@2026.10.03-2", at: "2026-10-03T12:00:00.000Z", environment: "production", author: null, description: null, url: null },
    { version: RELEASE, at: "2026-10-04T09:40:00.000Z", environment: "production", author: null, description: null, url: null },
  ];
}

export function sampleReleaseCommit(over: Partial<ReleaseCommit> = {}): ReleaseCommit {
  return { sha: SHA_RELEASE, repository: "acme/checkout-web", ...over };
}

/** A state right after eligibility passed, before locate. */
export function codeFixState(over: Partial<CodeFixState> = {}): CodeFixState {
  return {
    ...initialCodeFixState({
      attemptId: "fix_abcdef12",
      incidentId: "inc_1",
      scenarioId: "live:sentry",
      mode: "shadow",
      isolation: "isolated",
      service: "checkout-web",
      alertStartedAt: ALERT_STARTED_AT,
    }),
    repository: SAMPLE_REPO,
    connectorId: "sentry",
    errorGroupId: "4815162342",
    ...over,
  };
}

/** A state right after locate succeeded. */
export function locatedState(over: Partial<CodeFixState> = {}): CodeFixState {
  const ev = sampleErrorEvent();
  return codeFixState({
    stage: "locate",
    release: RELEASE,
    commitSha: SHA_RELEASE,
    exception: ev.exception,
    frames: ev.frames,
    anchor: frame(ANCHOR_PATH, ANCHOR_LINE, true, "summarize"),
    ...over,
  });
}

// ---------- connector query ----------

type Scripted<T> = T | Error | (() => T | Promise<T>);

async function play<T>(s: Scripted<T>): Promise<T> {
  if (s instanceof Error) throw s;
  if (typeof s === "function") return await (s as () => T | Promise<T>)();
  return structuredClone(s);
}

export type FakeQueryCall = { member: "errorEvent" | "deploys" | "releaseCommit"; q: Record<string, unknown> };

/** Connector query with the three members the fixer reads; `undefined` script means the member is absent. */
export class FakeConnectorQuery implements FixConnectorQuery {
  readonly calls: FakeQueryCall[] = [];
  errorEvent?: FixConnectorQuery["errorEvent"];
  deploys?: FixConnectorQuery["deploys"];
  releaseCommit?: FixConnectorQuery["releaseCommit"];

  constructor(o: { errorEvent?: Scripted<unknown>; deploys?: Scripted<DeployRecord[]>; releaseCommit?: Scripted<ReleaseCommit | null> } = {}) {
    const script = { errorEvent: sampleErrorEvent() as unknown, deploys: sampleDeploys(), releaseCommit: sampleReleaseCommit() as ReleaseCommit | null, ...o };
    this.errorEvent = async (q) => {
      this.calls.push({ member: "errorEvent", q: { ...q } });
      return (await play(script.errorEvent)) as ErrorEvent | null;
    };
    this.deploys = async (q) => {
      this.calls.push({ member: "deploys", q: { ...q } });
      return play(script.deploys);
    };
    this.releaseCommit = async (q) => {
      this.calls.push({ member: "releaseCommit", q: { ...q } });
      return play(script.releaseCommit);
    };
  }
}

// ---------- code host reader ----------

export type FakeReaderCall = { method: keyof CodeHostReader; args: Record<string, unknown> };

export class FakeCodeHostReader implements CodeHostReader {
  readonly calls: FakeReaderCall[] = [];
  private readonly o: {
    commits: readonly string[];
    commitExistsError?: Error;
    branch?: BranchInfo;
    compare?: string[];
    pull?: PullRequestInfo | null;
    ref?: GitRefInfo | null;
    commit?: CommitInfo;
  };

  constructor(o: Partial<FakeCodeHostReader["o"]> = {}) {
    this.o = { commits: [SHA_RELEASE, SHA_HEAD], ...o };
  }

  async commitExists(r: RepoRef & { sha: string }): Promise<boolean> {
    this.calls.push({ method: "commitExists", args: { ...r } });
    if (this.o.commitExistsError) throw this.o.commitExistsError;
    return this.o.commits.includes(r.sha);
  }
  async branchInfo(r: RepoRef & { branch: string }): Promise<BranchInfo> {
    this.calls.push({ method: "branchInfo", args: { ...r } });
    return this.o.branch ?? { name: r.branch, protected: true, headSha: SHA_HEAD };
  }
  async compareFiles(r: RepoRef & { base: string; head: string }): Promise<string[]> {
    this.calls.push({ method: "compareFiles", args: { ...r } });
    return [...(this.o.compare ?? [])];
  }
  async findPullByHead(r: RepoRef & { branch: string }): Promise<PullRequestInfo | null> {
    this.calls.push({ method: "findPullByHead", args: { ...r } });
    return this.o.pull ?? null;
  }
  async getRef(r: RepoRef & { ref: string }): Promise<GitRefInfo | null> {
    this.calls.push({ method: "getRef", args: { ...r } });
    return this.o.ref ?? null;
  }
  async getCommit(r: RepoRef & { sha: string }): Promise<CommitInfo> {
    this.calls.push({ method: "getCommit", args: { ...r } });
    return this.o.commit ?? { sha: r.sha, tree: "c".repeat(40), parents: [] };
  }
}

// ---------- workspace ----------

export type FakeFile = { text: string; mode?: FileMode };
export type FakeTree = Record<string, FakeFile | string>;

const asFile = (f: FakeFile | string): FakeFile => (typeof f === "string" ? { text: f, mode: "100644" } : { mode: "100644", ...f });

export type FakeWorkspaceCall =
  | { op: "readAt" | "modeAt"; sha: string; path: string }
  | { op: "sameAt"; a: string; b: string; path: string }
  | { op: "readFile" | "writeFile"; path: string }
  | { op: "listFiles"; globs: string[] }
  | { op: "stagedDiff" | "dispose" };

/** A two-commit repository in memory: the release commit and the base head; the work tree starts at the base head. */
export class FakeWorkspace implements Workspace {
  readonly root = "/fake/ic-fix-1";
  readonly repoDir = "/fake/ic-fix-1/repo";
  readonly tmpDir = "/fake/ic-fix-1/tmp";
  readonly kitDir = "/fake/ic-fix-1/kit";
  readonly baseHead: string;
  readonly calls: FakeWorkspaceCall[] = [];
  readonly writes: { path: string; content: string }[] = [];
  disposed = false;
  private readonly commits: Map<string, Map<string, FakeFile>>;
  private readonly tree: Map<string, FakeFile>;
  private readonly scriptedDiff: StagedDiff | ((ws: FakeWorkspace) => StagedDiff) | undefined;

  constructor(o: { baseHead?: string; commits: Record<string, FakeTree>; stagedDiff?: StagedDiff | ((ws: FakeWorkspace) => StagedDiff) }) {
    this.baseHead = o.baseHead ?? SHA_HEAD;
    this.commits = new Map(Object.entries(o.commits).map(([sha, files]) => [sha, new Map(Object.entries(files).map(([p, f]) => [p, asFile(f)]))]));
    this.tree = new Map(this.commits.get(this.baseHead) ?? []);
    this.scriptedDiff = o.stagedDiff;
  }

  async readAt(sha: string, path: string): Promise<string | null> {
    this.calls.push({ op: "readAt", sha, path });
    return this.commits.get(sha)?.get(path)?.text ?? null;
  }
  async modeAt(sha: string, path: string): Promise<FileMode | null> {
    this.calls.push({ op: "modeAt", sha, path });
    return this.commits.get(sha)?.get(path)?.mode ?? null;
  }
  async sameAt(a: string, b: string, path: string): Promise<boolean> {
    this.calls.push({ op: "sameAt", a, b, path });
    const fa = this.commits.get(a)?.get(path);
    const fb = this.commits.get(b)?.get(path);
    return fa !== undefined && fb !== undefined && fa.text === fb.text && fa.mode === fb.mode;
  }
  async readFile(path: string): Promise<string | null> {
    this.calls.push({ op: "readFile", path });
    const f = this.tree.get(path);
    return f !== undefined && (f.mode === "100644" || f.mode === "100755") ? f.text : null;
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.calls.push({ op: "writeFile", path });
    this.writes.push({ path, content });
    this.tree.set(path, { text: content, mode: this.tree.get(path)?.mode ?? "100644" });
  }
  async listFiles(globs: readonly string[]): Promise<string[]> {
    this.calls.push({ op: "listFiles", globs: [...globs] });
    const base = this.commits.get(this.baseHead) ?? new Map<string, FakeFile>();
    return [...base.keys()].filter((p) => matchesAnyGlob(p, globs)).sort();
  }
  async stagedDiff(): Promise<StagedDiff> {
    this.calls.push({ op: "stagedDiff" });
    if (this.scriptedDiff !== undefined) return typeof this.scriptedDiff === "function" ? this.scriptedDiff(this) : structuredClone(this.scriptedDiff);
    const base = this.commits.get(this.baseHead) ?? new Map<string, FakeFile>();
    const changes: WorkspaceChange[] = [];
    const parts: string[] = [];
    for (const path of [...new Set(this.writes.map((w) => w.path))].sort()) {
      const before = base.get(path)?.text ?? null;
      const after = this.tree.get(path)!.text;
      if (before === after) continue;
      const { added, removed } = countChangedLines(before ?? "", after);
      changes.push({ path, kind: before === null ? "added" : "modified", added, removed, binary: false, symlink: false });
      parts.push(`diff --git a/${path} b/${path}\n--- ${before === null ? "/dev/null" : `a/${path}`}\n+++ b/${path}\n`);
    }
    return { patch: parts.join(""), changes };
  }
  async dispose(): Promise<void> {
    this.calls.push({ op: "dispose" });
    this.disposed = true;
  }

  /** Current work-tree text (test helper; not part of the port). */
  workTreeText(path: string): string | null {
    return this.tree.get(path)?.text ?? null;
  }
}

/** The repository the sample event points at: the anchor file is identical at the release and the base head. */
export function sampleRepoTree(over: FakeTree = {}): FakeTree {
  const anchor = Array.from({ length: 40 }, (_, i) => (i + 1 === ANCHOR_LINE ? "  return cart.totals.total;" : `// line ${i + 1}`)).join("\n") + "\n";
  return {
    [ANCHOR_PATH]: anchor,
    "src/checkout/routes.ts": "export const routes = [];\n",
    "tests/checkout/cart.test.ts": "import { test } from \"node:test\";\n",
    "tests/other/far.test.ts": "import { test } from \"node:test\";\n",
    "package.json": JSON.stringify({ name: "checkout-web", type: "module", scripts: { test: "node --test", postinstall: "x" } }),
    "AGENTS.md": "# Agents\nUse node --test.\n",
    ...over,
  };
}

export function sampleWorkspace(o: { release?: FakeTree; head?: FakeTree } = {}): FakeWorkspace {
  return new FakeWorkspace({ commits: { [SHA_RELEASE]: o.release ?? sampleRepoTree(), [SHA_HEAD]: o.head ?? sampleRepoTree() } });
}

export class FakeGitWorkspace implements GitWorkspacePort {
  readonly calls: Omit<PrepareWorkspaceInput, "signal">[] = [];
  private readonly result: Workspace | Error;
  constructor(result: Workspace | Error) {
    this.result = result;
  }
  async prepare(input: PrepareWorkspaceInput): Promise<Workspace> {
    const { signal: _signal, ...rest } = input;
    this.calls.push(rest);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

// ---------- sandbox ----------

export function runSummary(over: Partial<SandboxRunResult> = {}): SandboxRunResult {
  return {
    outcome: "passed", exitCode: 0, total: 3, passed: 3, failed: 0, skipped: 0, todo: 0, cancelled: 0, durationMs: 120,
    failures: [], outputTail: "", ...over,
  };
}

export function failingRun(failures: TestFailure[], over: Partial<SandboxRunResult> = {}): SandboxRunResult {
  return runSummary({ outcome: "failed", exitCode: 1, total: failures.length, passed: 0, failed: failures.length, failures, ...over });
}

/** Drops the untrusted output tail, as the evidence stores it. */
export function summaryOf(r: SandboxRunResult): TestRunSummary {
  const { outputTail: _tail, ...summary } = r;
  return summary;
}

/** Plays one scripted result per call; a call past the script throws, so an unexpected run breaks the test. */
export class FakeSandboxRunner implements SandboxRunner {
  readonly calls: { files: string[]; timeoutSec: number }[] = [];
  private readonly script: (SandboxRunResult | Error)[];
  constructor(script: (SandboxRunResult | Error)[]) {
    this.script = [...script];
  }
  async run(input: SandboxRunInput): Promise<SandboxRunResult> {
    this.calls.push({ files: [...input.files], timeoutSec: input.timeoutSec });
    const next = this.script.shift();
    if (next === undefined) throw new Error(`FakeSandboxRunner: unscripted run #${this.calls.length}`);
    if (next instanceof Error) throw next;
    return structuredClone(next);
  }
  get remaining(): number {
    return this.script.length;
  }
}
