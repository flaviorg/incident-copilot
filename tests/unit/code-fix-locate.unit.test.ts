// Deterministic early nodes of the code fixer (spec 009, decisions 4 to 8; AC-61, AC-62, AC-63, AC-67, AC-81):
// eligibility, locate, workspace, baseline and give-up. None of them receives or calls the LLM.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ConnectorError } from "../../src/connectors/shared/errors.ts";
import type { EligibilityInput } from "../../src/domain/code-fix/eligibility.ts";
import { CODE_FIX_DEFAULT_LIMITS } from "../../src/domain/code-fix/limits.ts";
import { anchorChecks } from "../../src/infra/code-fix/git-workspace.ts";
import { readConventions } from "../../src/infra/code-fix/conventions.ts";
import { FakeLlmProvider } from "../../src/llm/fake-provider.ts";
import { fixTestPrompt } from "../../src/prompts/v1/index.ts";
import { createFixBaselineNode } from "../../src/graph/code-fix/nodes/fix-baseline-node.ts";
import { createFixEligibilityNode } from "../../src/graph/code-fix/nodes/fix-eligibility-node.ts";
import { createFixGiveUpNode } from "../../src/graph/code-fix/nodes/fix-give-up-node.ts";
import { createFixLocateNode } from "../../src/graph/code-fix/nodes/fix-locate-node.ts";
import type { FixLocateDeps } from "../../src/graph/code-fix/nodes/fix-locate-node.ts";
import { createFixWorkspaceNode } from "../../src/graph/code-fix/nodes/fix-workspace-node.ts";
import type { FixWorkspaceDeps } from "../../src/graph/code-fix/nodes/fix-workspace-node.ts";
import {
  afterBaseline, afterEligibility, afterLocate, afterWorkspace, FIX_END, LLM_NODE_IDS,
} from "../../src/graph/code-fix/routing.ts";
import type { FixNodeId } from "../../src/graph/code-fix/routing.ts";
import { createCodeFixSession, fixRunContext } from "../../src/graph/code-fix/state.ts";
import type { CodeFixNodeFn, CodeFixSession, CodeFixState } from "../../src/graph/code-fix/state.ts";
import {
  ALERT_STARTED_AT, ANCHOR_LINE, ANCHOR_PATH, codeFixState, failingRun, FakeCodeHostReader, FakeConnectorQuery, FakeGitWorkspace,
  FakeSandboxRunner, FakeWorkspace, frame, locatedState, RELEASE, runSummary, SAMPLE_REPO, sampleErrorEvent, sampleRepoTree,
  sampleWorkspace, SHA_HEAD, SHA_RELEASE, summaryOf,
} from "../helpers/code-fix-fakes.ts";

const limits = { ...CODE_FIX_DEFAULT_LIMITS };
const NOW = new Date("2026-10-04T10:00:00.000Z");

/** Applies a node's partial update like LangGraph's last-value reducers do. */
const apply = (s: CodeFixState, u: Partial<CodeFixState>): CodeFixState => ({ ...s, ...u });

// ---------- eligibility ----------

function eligibilityInput(over: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    status: "advised",
    escalation: null,
    origin: {
      kind: "connector", connectorId: "sentry", source: "sentry", fingerprint: "issue:4815162342", alertId: "a1", externalUrl: null, mode: "shadow",
    },
    diagnosis: { category: "bad_deploy", confidence: "high" },
    service: "checkout-web",
    repositories: [{ repo: SAMPLE_REPO.repo, service: SAMPLE_REPO.service, connector: SAMPLE_REPO.connector }],
    connectors: { sentry: { errorEvent: true, releaseCommit: true, deploys: true } },
    sandboxAvailable: true,
    limits,
    usage: { attemptsLast24h: () => 0, group: () => ({ attempts: 0, keyHeld: false }) },
    ...over,
  };
}

const blank = (): CodeFixState => codeFixState({ repository: null, connectorId: null, errorGroupId: null, stage: "eligibility" });

describe("fix_eligibility", () => {
  test("an ineligible incident is skipped with a typed reason and no locate call (AC-61)", async () => {
    const query = new FakeConnectorQuery();
    const reader = new FakeCodeHostReader();
    const node = createFixEligibilityNode({ repositories: [SAMPLE_REPO], eligibilityInput: () => eligibilityInput({ diagnosis: { category: "bad_deploy", confidence: "low" } }) });
    const s = apply(blank(), await node(blank()));
    assert.equal(s.stage, "eligibility");
    assert.equal(s.failure, "low_confidence");
    assert.equal(afterEligibility(s), "fix_give_up");
    const out = apply(s, await createFixGiveUpNode({ limits, redact: (t) => t })(s));
    assert.deepEqual(out.outcome, { status: "skipped", reason: "low_confidence" });
    assert.equal(out.suggestion, null);
    assert.equal(query.calls.length, 0);
    assert.equal(reader.calls.length, 0);
  });

  test("an eligible incident takes the repository and error group from code, then locates", async () => {
    const node = createFixEligibilityNode({ repositories: [SAMPLE_REPO], eligibilityInput: () => eligibilityInput() });
    const s = apply(blank(), await node(blank()));
    assert.equal(s.failure, null);
    assert.equal(s.repository?.repo, "acme/checkout-web");
    assert.equal(s.errorGroupId, "4815162342");
    assert.equal(s.connectorId, "sentry");
    assert.equal(afterEligibility(s), "fix_locate");
  });

  test("an allowlisted repository missing from the node's config fails closed", async () => {
    const node = createFixEligibilityNode({ repositories: [], eligibilityInput: () => eligibilityInput() });
    const s = apply(blank(), await node(blank()));
    assert.equal(s.failure, "service_not_allowlisted");
  });
});

// ---------- locate ----------

function locateDeps(o: { query?: FakeConnectorQuery | null; reader?: FakeCodeHostReader } = {}): FixLocateDeps & { q: FakeConnectorQuery | null; r: FakeCodeHostReader } {
  const q = o.query === undefined ? new FakeConnectorQuery() : o.query;
  const r = o.reader ?? new FakeCodeHostReader();
  return {
    q, r,
    query: (id) => (id === "sentry" ? q : null),
    reader: r,
    fixableExceptionTypes: ["TypeError", "RangeError", "ReferenceError"],
    now: () => NOW,
  };
}

async function locate(d: FixLocateDeps, s: CodeFixState = codeFixState()): Promise<CodeFixState> {
  return apply(s, await createFixLocateNode(d)(s));
}

describe("fix_locate", () => {
  test("maps the innermost in-app frame to a repo path and confirms the release commit (AC-62, AC-63)", async () => {
    const d = locateDeps();
    const s = await locate(d);
    assert.equal(s.failure, null);
    assert.equal(s.stage, "locate");
    assert.equal(afterLocate(s), "fix_workspace");
    assert.deepEqual(s.anchor, { file: ANCHOR_PATH, line: ANCHOR_LINE, column: 3, function: "summarize", inApp: true });
    assert.equal(s.release, RELEASE);
    assert.equal(s.commitSha, SHA_RELEASE);
    assert.equal(s.exception?.type, "TypeError");
    assert.equal(s.frames.length, 3);
    assert.deepEqual(d.q!.calls.map((c) => c.member), ["errorEvent", "deploys", "releaseCommit"]);
    assert.deepEqual(d.q!.calls[0]!.q, { service: "checkout-web", errorId: "4815162342" });
    assert.deepEqual(d.q!.calls[2]!.q, { service: "checkout-web", version: RELEASE });
    assert.deepEqual(d.r.calls, [{ method: "commitExists", args: { owner: "acme", repo: "checkout-web", sha: SHA_RELEASE } }]);
  });

  test("error_event_unavailable: null, a connector error, an invalid record or no query source", async () => {
    for (const errorEvent of [null, new ConnectorError("unavailable"), { errorId: 1, frames: "x" }]) {
      const d = locateDeps({ query: new FakeConnectorQuery({ errorEvent }) });
      const s = await locate(d);
      assert.equal(s.failure, "error_event_unavailable");
      assert.equal(afterLocate(s), "fix_give_up");
      assert.equal(d.r.calls.length, 0);
    }
    const none = await locate(locateDeps({ query: null }));
    assert.equal(none.failure, "error_event_unavailable");
    const noMember = new FakeConnectorQuery();
    delete noMember.errorEvent;
    assert.equal((await locate(locateDeps({ query: noMember }))).failure, "error_event_unavailable");
  });

  test("exception_not_fixable: a type outside fixableExceptionTypes", async () => {
    const d = locateDeps({ query: new FakeConnectorQuery({ errorEvent: sampleErrorEvent({ exception: { type: "SyntaxError", value: "x" } }) }) });
    const s = await locate(d);
    assert.equal(s.failure, "exception_not_fixable");
    assert.deepEqual(d.q!.calls.map((c) => c.member), ["errorEvent"]);
  });

  test("not_new_in_release: null release or firstSeen, no matching deploy, an old group or a failing deploys call", async () => {
    const cases = [
      new FakeConnectorQuery({ errorEvent: sampleErrorEvent({ release: null }) }),
      new FakeConnectorQuery({ errorEvent: sampleErrorEvent({ firstSeen: null }) }),
      new FakeConnectorQuery({ errorEvent: sampleErrorEvent({ firstSeen: "2026-10-01T00:00:00.000Z" }) }),
      new FakeConnectorQuery({ deploys: [] }),
      new FakeConnectorQuery({ deploys: new ConnectorError("timeout") }),
      new FakeConnectorQuery({ deploys: [{ version: RELEASE, at: "2026-10-04T11:00:00.000Z", environment: null, author: null, description: null, url: null }] }),
    ];
    for (const q of cases) {
      const d = locateDeps({ query: q });
      const s = await locate(d);
      assert.equal(s.failure, "not_new_in_release");
      assert.equal(q.calls.some((c) => c.member === "releaseCommit"), false);
      assert.equal(d.r.calls.length, 0);
    }
  });

  test("no_in_app_frame, path_not_allowlisted and path_denied come from the innermost in-app frame only", async () => {
    const withFrames = (frames: ReturnType<typeof frame>[]) => new FakeConnectorQuery({ errorEvent: sampleErrorEvent({ frames }) });
    const noInApp = await locate(locateDeps({ query: withFrames([frame("node:internal/x", 1, false), frame("node_modules/a/b.js", 3, false)]) }));
    assert.equal(noInApp.failure, "no_in_app_frame");
    for (const file of ["/srv/app/node_modules/x/y.js", "lib/other.ts", "../etc/passwd.ts", "src/checkout/bundle.min.js", "src/checkout/a.py"]) {
      const s = await locate(locateDeps({ query: withFrames([frame("src/checkout/routes.ts", 4), frame(file, 9)]) }));
      assert.equal(s.failure, "path_not_allowlisted", file);
    }
    for (const file of ["src/pricing/total.ts", "/srv/app/src/auth/login.ts", "src/session-store.ts"]) {
      const s = await locate(locateDeps({ query: withFrames([frame(file, 9)]) }));
      assert.equal(s.failure, "path_denied", file);
      assert.equal(s.anchor, null);
    }
  });

  test("commit_unresolved: no release commit in the allowlisted repository and a version that is not a SHA", async () => {
    for (const releaseCommit of [null, { sha: SHA_RELEASE, repository: "evil/fork" }, { sha: SHA_RELEASE, repository: null }, new ConnectorError("bad_response")]) {
      const d = locateDeps({ query: new FakeConnectorQuery({ releaseCommit }) });
      const s = await locate(d);
      assert.equal(s.failure, "commit_unresolved");
      assert.equal(d.r.calls.length, 0);
    }
  });

  test("the release version is used when it carries a 40-hex SHA", async () => {
    const release = `checkout-web@${SHA_HEAD}`;
    const q = new FakeConnectorQuery({
      errorEvent: sampleErrorEvent({ release }),
      deploys: [{ version: release, at: "2026-10-04T09:40:00.000Z", environment: null, author: null, description: null, url: null }],
      releaseCommit: null,
    });
    const s = await locate(locateDeps({ query: q }));
    assert.equal(s.failure, null);
    assert.equal(s.commitSha, SHA_HEAD);
  });

  test("commit_not_found: the code host does not confirm the SHA, or the check fails", async () => {
    assert.equal((await locate(locateDeps({ reader: new FakeCodeHostReader({ commits: [] }) }))).failure, "commit_not_found");
    const failing = new FakeCodeHostReader({ commitExistsError: Object.assign(new Error("x"), { name: "CodeHostError" }) });
    assert.equal((await locate(locateDeps({ reader: failing }))).failure, "commit_not_found");
  });

  test("an aborted attempt stops before any connector call (AC-81)", async () => {
    const d = locateDeps();
    const ac = new AbortController();
    ac.abort();
    const s = codeFixState();
    const out = apply(s, await createFixLocateNode(d)(s, { signal: ac.signal }));
    assert.equal(out.failure, "attempt_timeout");
    assert.equal(d.q!.calls.length, 0);
  });

  test("skip reasons before the workspace end skipped, with no suggestion", async () => {
    const s = await locate(locateDeps({ reader: new FakeCodeHostReader({ commits: [] }) }));
    const out = apply(s, await createFixGiveUpNode({ limits, redact: (t) => t })(s));
    assert.deepEqual(out.outcome, { status: "skipped", reason: "commit_not_found" });
    assert.equal(out.suggestion, null);
  });
});

// ---------- workspace ----------

function workspaceDeps(git: FakeGitWorkspace, session: CodeFixSession = createCodeFixSession()): FixWorkspaceDeps & { sandboxes: FakeSandboxRunner[] } {
  const sandboxes: FakeSandboxRunner[] = [];
  return {
    sandboxes,
    git,
    session,
    sandboxFor: () => {
      const r = new FakeSandboxRunner([]);
      sandboxes.push(r);
      return r;
    },
    cloneUrl: (repo) => `https://github.com/${repo}.git`,
    token: null,
    checkAnchor: anchorChecks,
    readConventions,
  };
}

async function workspace(d: FixWorkspaceDeps, s: CodeFixState = locatedState()): Promise<CodeFixState> {
  return apply(s, await createFixWorkspaceNode(d)(s));
}

describe("fix_workspace", () => {
  test("prepares the allowlisted repository at the confirmed commit and collects the conventions", async () => {
    const ws = sampleWorkspace();
    const git = new FakeGitWorkspace(ws);
    const d = workspaceDeps(git);
    const s = await workspace(d);
    assert.equal(s.failure, null);
    assert.equal(s.stage, "workspace");
    assert.equal(afterWorkspace(s), "fix_baseline");
    assert.deepEqual(git.calls, [{ repo: "acme/checkout-web", cloneUrl: "https://github.com/acme/checkout-web.git", baseBranch: "main", commitSha: SHA_RELEASE, token: null }]);
    assert.equal(s.baseCommitSha, SHA_HEAD);
    assert.equal(d.session.workspace, ws);
    assert.equal(d.session.sandbox, d.sandboxes[0]);
    const kinds = s.conventions!.files.map((f) => `${f.kind}:${f.path}`);
    assert.deepEqual(kinds, [
      `anchor_window:${ANCHOR_PATH}`, "nearest_test:tests/checkout/cart.test.ts", "nearest_test:tests/other/far.test.ts", "package_json:package.json", "agents:AGENTS.md",
    ]);
    assert.ok(!s.conventions!.files.find((f) => f.kind === "package_json")!.text.includes("postinstall"));
    assert.equal(ws.writes.length, 0);
  });

  test("workspace_failed: the fetch throws; nothing is kept in the session", async () => {
    const d = workspaceDeps(new FakeGitWorkspace(new Error("git fetch failed")));
    const s = await workspace(d);
    assert.equal(s.failure, "workspace_failed");
    assert.equal(afterWorkspace(s), "fix_give_up");
    assert.equal(d.session.workspace, null);
    assert.equal(d.sandboxes.length, 0);
  });

  test("workspace_failed: reading the conventions throws; the workspace stays in the session for disposal", async () => {
    const ws = sampleWorkspace();
    const d = { ...workspaceDeps(new FakeGitWorkspace(ws)), readConventions: async () => { throw new Error("io"); } };
    const s = await workspace(d);
    assert.equal(s.failure, "workspace_failed");
    assert.equal(d.session.workspace, ws);
  });

  test("file_changed_since_release: the anchor differs at the base head or is missing at the release", async () => {
    const changed = sampleWorkspace({ head: sampleRepoTree({ [ANCHOR_PATH]: "export const x = 1;\n".repeat(40) }) });
    assert.equal((await workspace(workspaceDeps(new FakeGitWorkspace(changed)))).failure, "file_changed_since_release");
    const { [ANCHOR_PATH]: _gone, ...rest } = sampleRepoTree();
    const missing = sampleWorkspace({ release: rest });
    assert.equal((await workspace(workspaceDeps(new FakeGitWorkspace(missing)))).failure, "file_changed_since_release");
  });

  test("line_out_of_range: the anchor line is past the end of the file at the release", async () => {
    const short = sampleRepoTree({ [ANCHOR_PATH]: "a\nb\nc\n" });
    const ws = sampleWorkspace({ release: short, head: short });
    const s = await workspace(workspaceDeps(new FakeGitWorkspace(ws)));
    assert.equal(s.failure, "line_out_of_range");
    assert.equal(afterWorkspace(s), "fix_give_up");
  });

  test("file_not_regular: a symlink or submodule at the release or the base head", async () => {
    const text = sampleRepoTree()[ANCHOR_PATH] as string;
    const link = sampleWorkspace({ head: sampleRepoTree({ [ANCHOR_PATH]: { text, mode: "120000" } }) });
    assert.equal((await workspace(workspaceDeps(new FakeGitWorkspace(link)))).failure, "file_not_regular");
    const exec = sampleWorkspace({ release: sampleRepoTree({ [ANCHOR_PATH]: { text, mode: "100755" } }) });
    assert.equal((await workspace(workspaceDeps(new FakeGitWorkspace(exec)))).failure, "file_not_regular");
  });

  test("a give-up after the workspace is gave_up with a suggestion built from facts", async () => {
    const short = sampleRepoTree({ [ANCHOR_PATH]: "a\n" });
    const s = await workspace(workspaceDeps(new FakeGitWorkspace(sampleWorkspace({ release: short, head: short }))));
    const out = apply(s, await createFixGiveUpNode({ limits, redact: (t) => t })(s));
    assert.deepEqual(out.outcome, { status: "gave_up", reason: "line_out_of_range" });
    assert.equal(out.suggestion?.reason, "line_out_of_range");
    assert.deepEqual(out.suggestion?.anchor, s.anchor);
    assert.equal(out.suggestion?.modelRationale, null);
  });
});

// ---------- baseline ----------

function baselineState(sandbox: FakeSandboxRunner): { s: CodeFixState; session: CodeFixSession } {
  const session = createCodeFixSession();
  session.workspace = sampleWorkspace();
  session.sandbox = sandbox;
  return { s: locatedState({ stage: "workspace", baseCommitSha: SHA_HEAD }), session };
}

describe("fix_baseline", () => {
  test("a green suite with tests is stored as evidence without the output tail, then the test author is next", async () => {
    const run = runSummary({ total: 7, passed: 7, outputTail: "untrusted output" });
    const sandbox = new FakeSandboxRunner([run]);
    const { s, session } = baselineState(sandbox);
    const out = apply(s, await createFixBaselineNode({ session, limits })(s));
    assert.equal(out.failure, null);
    assert.equal(out.stage, "baseline");
    assert.deepEqual(out.evidence.baseline, summaryOf(run));
    assert.deepEqual(sandbox.calls, [{ files: SAMPLE_REPO.testFiles, timeoutSec: limits.testTimeoutSec }]);
    assert.equal(afterBaseline(out, limits), "fix_author_test");
  });

  test("baseline_not_green, baseline_timeout and sandbox_error (AC-67)", async () => {
    const cases: [ReturnType<typeof runSummary> | Error, string][] = [
      [failingRun([{ name: "t", file: "tests/a.test.ts", errorName: "AssertionError", message: "x", frames: [] }]), "baseline_not_green"],
      // Zero tests as the real runner reports them: `error`, exit 0, total 0 (tests/e2e/code-fix-sandbox.e2e.test.ts).
      [runSummary({ outcome: "error", exitCode: 0, total: 0, passed: 0 }), "baseline_not_green"],
      [runSummary({ cancelled: 1, total: 3, passed: 2 }), "baseline_not_green"],
      [runSummary({ outcome: "timeout", exitCode: null }), "baseline_timeout"],
      [runSummary({ outcome: "error", exitCode: 1, total: 0, passed: 0 }), "sandbox_error"],
      [new Error("spawn failed"), "sandbox_error"],
    ];
    for (const [run, reason] of cases) {
      const { s, session } = baselineState(new FakeSandboxRunner([run]));
      const out = apply(s, await createFixBaselineNode({ session, limits })(s));
      assert.equal(out.failure, reason);
      assert.equal(afterBaseline(out, limits), "fix_give_up");
      const end = apply(out, await createFixGiveUpNode({ limits, redact: (t) => t })(out));
      assert.equal(end.outcome.status, "gave_up");
      assert.equal(end.outcome.reason, reason);
    }
  });

  test("no sandbox in the session is a sandbox_error", async () => {
    const s = locatedState({ stage: "workspace" });
    const out = apply(s, await createFixBaselineNode({ session: createCodeFixSession(), limits })(s));
    assert.equal(out.failure, "sandbox_error");
  });
});

// ---------- give-up ----------

describe("fix_give_up", () => {
  test("budget_exhausted when the budget route sent the attempt here", async () => {
    const s = locatedState({ stage: "baseline", failure: null, llm: { calls: 6, promptTokens: 0, completionTokens: 0 } });
    const out = apply(s, await createFixGiveUpNode({ limits, redact: (t) => t })(s));
    assert.deepEqual(out.outcome, { status: "gave_up", reason: "budget_exhausted" });
  });

  test("the suggestion keeps the model rationale only as redacted, clipped text", async () => {
    const secret = "sk-or-v1-" + "a".repeat(40);
    const s = locatedState({
      stage: "repro", failure: "repro_flaky", authorTestCalls: 1,
      testProposal: { test: { path: "tests/checkout/x.test.ts", content: "t" }, rationale: `cart.totals is undefined ${secret}` },
    });
    const out = apply(s, await createFixGiveUpNode({ limits, redact: (t) => t.split(secret).join("[REDACTED]") })(s));
    assert.equal(out.outcome.reason, "repro_flaky");
    assert.equal(out.suggestion?.modelRationale?.includes(secret), false);
    assert.ok(out.suggestion?.modelRationale?.includes("[REDACTED]"));
  });

  test("an attempt timeout during locate is gave_up, not skipped", async () => {
    const s = codeFixState({ stage: "locate", failure: "attempt_timeout" });
    const out = apply(s, await createFixGiveUpNode({ limits, redact: (t) => t })(s));
    assert.deepEqual(out.outcome, { status: "gave_up", reason: "attempt_timeout" });
  });
});

// ---------- the early pipeline never reaches the LLM ----------

/** Runs nodes through the real routes until END or an LLM node; reaching an LLM node calls the strict fake. */
async function runEarly(nodes: Partial<Record<FixNodeId, CodeFixNodeFn>>, start: CodeFixState, llm: FakeLlmProvider, stopAtLlm: boolean) {
  const routes: Partial<Record<FixNodeId, (s: CodeFixState) => string>> = {
    fix_eligibility: afterEligibility, fix_locate: afterLocate, fix_workspace: afterWorkspace, fix_baseline: (s) => afterBaseline(s, limits),
    fix_give_up: () => FIX_END,
  };
  let s = start;
  let id: string = "fix_eligibility";
  const path: string[] = [];
  while (id !== FIX_END) {
    if ((LLM_NODE_IDS as readonly string[]).includes(id)) {
      if (stopAtLlm) return { s, path, next: id };
      await llm.generate(fixTestPrompt, {} as never, fixRunContext(s));
    }
    path.push(id);
    s = apply(s, await nodes[id as FixNodeId]!(s));
    id = routes[id as FixNodeId]!(s);
  }
  return { s, path, next: id };
}

describe("early pipeline", () => {
  const build = (o: { query?: FakeConnectorQuery; ws?: FakeWorkspace; runs: Parameters<typeof runSummary>[0][]; eligible?: boolean }) => {
    const session = createCodeFixSession();
    const sandbox = new FakeSandboxRunner(o.runs.map((r) => runSummary(r)));
    const ld = locateDeps({ query: o.query ?? new FakeConnectorQuery() });
    const nodes: Partial<Record<FixNodeId, CodeFixNodeFn>> = {
      fix_eligibility: createFixEligibilityNode({
        repositories: [SAMPLE_REPO],
        eligibilityInput: () => eligibilityInput(o.eligible === false ? { sandboxAvailable: false } : {}),
      }),
      fix_locate: createFixLocateNode(ld),
      fix_workspace: createFixWorkspaceNode({ ...workspaceDeps(new FakeGitWorkspace(o.ws ?? sampleWorkspace()), session), sandboxFor: () => sandbox }),
      fix_baseline: createFixBaselineNode({ session, limits }),
      fix_give_up: createFixGiveUpNode({ limits, redact: (t) => t }),
    };
    return { nodes, sandbox, query: ld.q! };
  };

  test("ineligible, unlocatable, changed or red baselines end before any LLM node; the fake LLM is never called", async () => {
    const llm = new FakeLlmProvider({ fixtures: [] });
    const cases = [
      { o: build({ runs: [], eligible: false }), reason: "sandbox_unavailable", path: ["fix_eligibility", "fix_give_up"] },
      { o: build({ runs: [], query: new FakeConnectorQuery({ errorEvent: null }) }), reason: "error_event_unavailable", path: ["fix_eligibility", "fix_locate", "fix_give_up"] },
      {
        o: build({ runs: [], ws: sampleWorkspace({ head: sampleRepoTree({ [ANCHOR_PATH]: "changed\n" }) }) }),
        reason: "file_changed_since_release", path: ["fix_eligibility", "fix_locate", "fix_workspace", "fix_give_up"],
      },
      { o: build({ runs: [{ outcome: "failed", failed: 1, passed: 2 }] }), reason: "baseline_not_green", path: ["fix_eligibility", "fix_locate", "fix_workspace", "fix_baseline", "fix_give_up"] },
    ];
    for (const c of cases) {
      const r = await runEarly(c.o.nodes, blank(), llm, false);
      assert.equal(r.s.outcome.reason, c.reason);
      assert.deepEqual(r.path, c.path);
      if (c.reason === "sandbox_unavailable") assert.equal(c.o.query.calls.length, 0);
    }
    assert.equal(llm.calls().length, 0);
  });

  test("a green baseline is the first point where an LLM node may run", async () => {
    const llm = new FakeLlmProvider({ fixtures: [] });
    const o = build({ runs: [{}] });
    const r = await runEarly(o.nodes, blank(), llm, true);
    assert.equal(r.next, "fix_author_test");
    assert.equal(r.s.outcome.status, "running");
    assert.equal(r.s.alertStartedAt, ALERT_STARTED_AT);
    assert.equal(o.sandbox.calls.length, 1);
    assert.equal(llm.calls().length, 0);
  });

  test("the node factories receive no LLM and no code-host writer", () => {
    const ld = locateDeps();
    for (const deps of [ld, workspaceDeps(new FakeGitWorkspace(new Error("x")))] as object[]) {
      for (const key of Object.keys(deps)) assert.doesNotMatch(key, /llm|writer/i);
    }
  });
});
