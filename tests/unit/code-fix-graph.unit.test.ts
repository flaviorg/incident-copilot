// The compiled code fixer graph end to end (spec 009, decisions 2, 8, 11, 12 and 17; AC-67, AC-69 to AC-72, AC-81).
// Every node is built by its real factory over the in-memory fakes and the strict FakeLlmProvider; each variant is
// derived from one happy-path script with patchFixture. The tests assert outcomes, stages, the order of LLM calls,
// work-tree writes and sandbox runs, and that every scripted turn was consumed. No free LLM text is asserted.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { TestFailure } from "../../src/contracts/index.ts";
import type { EligibilityInput } from "../../src/domain/code-fix/eligibility.ts";
import { CODE_FIX_DEFAULT_LIMITS } from "../../src/domain/code-fix/limits.ts";
import type { CodeFixLimits } from "../../src/domain/code-fix/limits.ts";
import type { SandboxRunInput, SandboxRunner, SandboxRunResult } from "../../src/domain/code-fix/ports.ts";
import { anchorChecks } from "../../src/infra/code-fix/git-workspace.ts";
import { readConventions } from "../../src/infra/code-fix/conventions.ts";
import { FakeLlmProvider } from "../../src/llm/fake-provider.ts";
import type { FixtureFile, FixtureTurn } from "../../src/llm/fixture-format.ts";
import { promptHash } from "../../src/llm/prompt-hash.ts";
import type { LlmProvider } from "../../src/llm/provider.ts";
import { fixPatchPrompt, fixReviewPrompt, fixTestPrompt } from "../../src/prompts/v1/index.ts";
import { buildCodeFixGraph, CODE_FIX_RECURSION_LIMIT } from "../../src/graph/code-fix/graph.ts";
import type { CodeFixGraphNodes } from "../../src/graph/code-fix/graph.ts";
import { createFixAuthorPatchNode } from "../../src/graph/code-fix/nodes/fix-author-patch-node.ts";
import { createFixAuthorTestNode } from "../../src/graph/code-fix/nodes/fix-author-test-node.ts";
import { createFixBaselineNode } from "../../src/graph/code-fix/nodes/fix-baseline-node.ts";
import { createFixEligibilityNode } from "../../src/graph/code-fix/nodes/fix-eligibility-node.ts";
import { createFixFinalizeNode } from "../../src/graph/code-fix/nodes/fix-finalize-node.ts";
import { createFixGiveUpNode } from "../../src/graph/code-fix/nodes/fix-give-up-node.ts";
import { createFixGuardPatchNode } from "../../src/graph/code-fix/nodes/fix-guard-patch-node.ts";
import { createFixGuardTestNode } from "../../src/graph/code-fix/nodes/fix-guard-test-node.ts";
import { createFixLocateNode } from "../../src/graph/code-fix/nodes/fix-locate-node.ts";
import { createFixReproNode } from "../../src/graph/code-fix/nodes/fix-repro-node.ts";
import { createFixReviewNode } from "../../src/graph/code-fix/nodes/fix-review-node.ts";
import { createFixVerifyNode } from "../../src/graph/code-fix/nodes/fix-verify-node.ts";
import { createFixWorkspaceNode } from "../../src/graph/code-fix/nodes/fix-workspace-node.ts";
import { FIX_NODE_IDS } from "../../src/graph/code-fix/routing.ts";
import { CodeFixStateSchema, createCodeFixSession } from "../../src/graph/code-fix/state.ts";
import type { CodeFixState } from "../../src/graph/code-fix/state.ts";
import {
  ANCHOR_LINE, ANCHOR_PATH, codeFixState, failingRun, FakeCodeHostReader, FakeConnectorQuery, FakeGitWorkspace, FakeSandboxRunner,
  FakeWorkspace, runSummary, SAMPLE_REPO, sampleRepoTree, SHA_HEAD, SHA_RELEASE,
} from "../helpers/code-fix-fakes.ts";
import { patchFixture } from "../helpers/fixtures.ts";

const NOW = new Date("2026-10-04T10:30:00.000Z");
const identity = (t: string) => t;
const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

// ---------- facts ----------

const TEST_PATH = "tests/checkout/cart-summary.regression.test.ts";
const TEST_NAME = "summarize returns zero for a cart without totals";
const TEST_CONTENT = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import { summarize } from "../../src/checkout/cart-summary.ts";',
  "",
  `test("${TEST_NAME}", () => {`,
  "  assert.equal(summarize({ items: [] }).total, 0);",
  "});",
  "",
].join("\n");
/** Fails the guard: it does not import the anchor module. */
const BAD_TEST_CONTENT = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  "",
  `test("${TEST_NAME}", () => {`,
  "  assert.equal(1 + 1, 3);",
  "});",
  "",
].join("\n");
const SEARCH = "  return cart.totals.total;";
const REPLACE = "  return cart.totals?.total ?? 0;";
const ANCHOR_ORIGINAL = sampleRepoTree()[ANCHOR_PATH] as string;
const BASELINE_TOTAL = 3;

const testOutput = (content = TEST_CONTENT) => ({ test: { path: TEST_PATH, content }, rationale: "Calls summarize with a cart that has no totals." });
const patchOutput = () => ({ edits: [{ path: ANCHOR_PATH, search: SEARCH, replace: REPLACE }], rationale: "Guards the missing totals." });

const rightFailure = (over: Partial<TestFailure> = {}): TestFailure => ({
  name: TEST_NAME, file: TEST_PATH, errorName: "TypeError", message: "Cannot read properties of undefined (reading 'total')",
  frames: [{ file: ANCHOR_PATH, line: ANCHOR_LINE }, { file: TEST_PATH, line: 6 }], ...over,
});
const wrongFailure = () => rightFailure({ errorName: "AssertionError", message: "Expected values to be strictly equal", frames: [{ file: TEST_PATH, line: 6 }] });

const baselineRun = () => runSummary({ total: BASELINE_TOTAL, passed: BASELINE_TOTAL });
const reproRun = () => failingRun([rightFailure()]);
const fixPass = () => runSummary({ total: 1, passed: 1 });
const suitePass = () => runSummary({ total: BASELINE_TOTAL + 1, passed: BASELINE_TOTAL + 1 });

// ---------- fixture ----------

const repoKey = { repo: SAMPLE_REPO.repo };

/** The happy path: one test, one patch, one approving review. */
const BASE: FixtureFile = {
  schemaVersion: 1,
  scenarioId: "live:sentry",
  promptHashes: {
    [fixTestPrompt.version]: promptHash(fixTestPrompt),
    [fixPatchPrompt.version]: promptHash(fixPatchPrompt),
    [fixReviewPrompt.version]: promptHash(fixReviewPrompt),
  },
  turns: [
    { id: "t1", prompt: "fix-test.v1", when: { ...repoKey, attempt: 1 }, output: testOutput() },
    { id: "p1", prompt: "fix-patch.v1", when: { ...repoKey, attempt: 1 }, output: patchOutput() },
    { id: "r1", prompt: "fix-review.v1", when: repoKey, output: { verdict: "approve", concerns: [] } },
  ],
};

const turn = (id: string, attempt: number | null, output: unknown, extra: Partial<FixtureTurn> = {}): FixtureTurn => ({
  id, prompt: "", when: attempt === null ? repoKey : { ...repoKey, attempt }, output, ...extra,
});

// ---------- harness ----------

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
    limits: CODE_FIX_DEFAULT_LIMITS,
    usage: { attemptsLast24h: () => 0, group: () => ({ attempts: 0, keyHeld: false }) },
    ...over,
  };
}

/** A work tree that logs its writes into the shared event list. */
class LoggedWorkspace extends FakeWorkspace {
  private readonly events: string[];
  constructor(events: string[], head = sampleRepoTree()) {
    super({ commits: { [SHA_RELEASE]: sampleRepoTree(), [SHA_HEAD]: head } });
    this.events = events;
  }
  override async writeFile(path: string, content: string): Promise<void> {
    this.events.push(`write:${path}`);
    await super.writeFile(path, content);
  }
}

type Harness = {
  graph: ReturnType<typeof buildCodeFixGraph>;
  llm: FakeLlmProvider;
  ws: LoggedWorkspace;
  sandbox: FakeSandboxRunner;
  query: FakeConnectorQuery;
  events: string[];
  abort: AbortController;
};

function harness(o: {
  fixture?: FixtureFile;
  runs: (SandboxRunResult | Error)[];
  limits?: Partial<CodeFixLimits>;
  eligibility?: Partial<EligibilityInput>;
  query?: FakeConnectorQuery;
  head?: ReturnType<typeof sampleRepoTree>;
  /** Called before each sandbox run, with its 1-based number. */
  onRun?: (n: number, h: { abort: AbortController }) => void;
}): Harness {
  const limits: CodeFixLimits = { ...CODE_FIX_DEFAULT_LIMITS, ...o.limits };
  const events: string[] = [];
  const abort = new AbortController();
  const fake = new FakeLlmProvider({ fixtures: [o.fixture ?? BASE] });
  const llm: LlmProvider = {
    name: "fake",
    generate: (prompt, input, ctx) => {
      events.push(`llm:${prompt.version}`);
      return fake.generate(prompt, input, ctx);
    },
  };
  const ws = new LoggedWorkspace(events, o.head);
  const inner = new FakeSandboxRunner(o.runs);
  let runs = 0;
  const sandbox: SandboxRunner = {
    run: async (input: SandboxRunInput) => {
      runs += 1;
      events.push(`run:${input.files.join(",")}`);
      o.onRun?.(runs, { abort });
      return inner.run(input);
    },
  };
  const query = o.query ?? new FakeConnectorQuery();
  const session = createCodeFixSession();
  const nodes: CodeFixGraphNodes = {
    fix_eligibility: createFixEligibilityNode({ repositories: [SAMPLE_REPO], eligibilityInput: () => eligibilityInput(o.eligibility) }),
    fix_locate: createFixLocateNode({
      query: (id) => (id === "sentry" ? query : null),
      reader: new FakeCodeHostReader(),
      fixableExceptionTypes: ["TypeError", "RangeError", "ReferenceError"],
      now: () => NOW,
    }),
    fix_workspace: createFixWorkspaceNode({
      git: new FakeGitWorkspace(ws),
      session,
      sandboxFor: () => sandbox,
      cloneUrl: (repo) => `https://github.com/${repo}.git`,
      token: null,
      checkAnchor: anchorChecks,
      readConventions,
    }),
    fix_baseline: createFixBaselineNode({ session, limits }),
    fix_author_test: createFixAuthorTestNode({ llm, redact: identity }),
    fix_guard_test: createFixGuardTestNode({ session, limits }),
    fix_repro: createFixReproNode({ session, limits }),
    fix_author_patch: createFixAuthorPatchNode({ llm, redact: identity }),
    fix_guard_patch: createFixGuardPatchNode({ session, limits }),
    fix_verify: createFixVerifyNode({ session, limits, sha256, redact: identity }),
    fix_review: createFixReviewNode({ llm, redact: identity }),
    fix_finalize: createFixFinalizeNode({ sha256, now: () => NOW }),
    fix_give_up: createFixGiveUpNode({ limits, redact: identity }),
  };
  return { graph: buildCodeFixGraph(nodes, { limits }), llm: fake, ws, sandbox: inner, query, events, abort };
}

const start = (): CodeFixState => codeFixState({ repository: null, connectorId: null, errorGroupId: null, stage: "eligibility" });

/** Runs the graph to its end, collecting the stage of every superstep's state. */
async function run(h: Harness, recursionLimit = CODE_FIX_RECURSION_LIMIT) {
  const stages: string[] = [];
  let last: CodeFixState | null = null;
  const stream = await h.graph.stream(start(), { recursionLimit, signal: h.abort.signal, requestId: null });
  for await (const s of stream) {
    if (stages.at(-1) !== s.stage || last === null) stages.push(s.stage);
    last = s;
  }
  assert.ok(last !== null);
  return { s: last, stages };
}

const prompts = (h: Harness) => h.events.filter((e) => e.startsWith("llm:")).map((e) => e.slice(4));
const io = (h: Harness) => h.events.filter((e) => !e.startsWith("llm:"));

const RUN_TEST = `run:${TEST_PATH}`;
const RUN_SUITE = `run:${SAMPLE_REPO.testFiles.join(",")}`;
const WRITE_TEST = `write:${TEST_PATH}`;
const WRITE_SOURCE = `write:${ANCHOR_PATH}`;

/** No source file is written before two repro runs of the written test have happened. */
function assertNoSourceWriteBeforeRepro(h: Harness): void {
  const e = io(h);
  const firstSource = e.indexOf(WRITE_SOURCE);
  if (firstSource === -1) return;
  const before = e.slice(0, firstSource);
  const testWrite = before.lastIndexOf(WRITE_TEST);
  assert.ok(testWrite >= 0, "the test file is written first");
  assert.ok(before.slice(testWrite).filter((x) => x === RUN_TEST).length >= 2, "two repro runs precede any source write");
}

function assertEnd(r: { s: CodeFixState }, status: CodeFixState["outcome"]["status"], reason: CodeFixState["outcome"]["reason"], stage: CodeFixState["stage"]): void {
  assert.deepEqual(r.s.outcome, { status, reason });
  assert.equal(r.s.stage, stage);
}

// =====================================================================================================================

describe("buildCodeFixGraph", () => {
  test("node ids carry the fix_ prefix and none equals a state key (decision 2)", () => {
    const keys = Object.keys(CodeFixStateSchema.shape);
    for (const id of FIX_NODE_IDS) {
      assert.match(id, /^fix_/);
      assert.equal(keys.includes(id), false);
    }
    assert.equal(CODE_FIX_RECURSION_LIMIT, 24);
  });

  test("a missing node is refused at build time", () => {
    assert.throws(() => buildCodeFixGraph({} as CodeFixGraphNodes, { limits: CODE_FIX_DEFAULT_LIMITS }), /fix_eligibility/);
  });

  test("the caller's recursionLimit bounds the run", async () => {
    const h = harness({ runs: [baselineRun(), reproRun(), reproRun(), fixPass(), fixPass(), suitePass()] });
    await assert.rejects(run(h, 3), /recursion/i);
  });

  test("invoke returns the last state of the same run", async () => {
    const h = harness({ runs: [baselineRun(), reproRun(), reproRun(), fixPass(), fixPass(), suitePass()] });
    const s = await h.graph.invoke(start(), { recursionLimit: CODE_FIX_RECURSION_LIMIT, signal: h.abort.signal, requestId: "req_1" });
    assert.deepEqual(s.outcome, { status: "patch_ready", reason: null });
    h.llm.assertAllConsumed();
  });
});

describe("code fixer graph end to end", () => {
  test("happy path: patch_ready, with the test written and reproduced before any source write (AC-69, AC-71, AC-72)", async () => {
    const h = harness({ runs: [baselineRun(), reproRun(), reproRun(), fixPass(), fixPass(), suitePass()] });
    const r = await run(h);
    assertEnd(r, "patch_ready", null, "finalize");
    assert.equal(r.s.failure, null);
    assert.deepEqual(r.stages, [
      "eligibility", "locate", "workspace", "baseline", "author_test", "guard_test", "repro", "author_patch", "guard_patch", "verify", "review", "finalize",
    ]);
    assert.deepEqual(prompts(h), ["fix-test.v1", "fix-patch.v1", "fix-review.v1"]);
    assert.deepEqual(io(h), [RUN_SUITE, WRITE_TEST, RUN_TEST, RUN_TEST, WRITE_SOURCE, RUN_TEST, RUN_TEST, RUN_SUITE]);
    assert.deepEqual(h.events, [
      RUN_SUITE, "llm:fix-test.v1", WRITE_TEST, RUN_TEST, RUN_TEST, "llm:fix-patch.v1", WRITE_SOURCE, RUN_TEST, RUN_TEST, RUN_SUITE, "llm:fix-review.v1",
    ]);
    assertNoSourceWriteBeforeRepro(h);
    assert.equal(r.s.llm.calls, 3);
    assert.equal(r.s.authorTestCalls, 1);
    assert.equal(r.s.authorPatchCalls, 1);
    assert.match(r.s.patchSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(r.s.patchReadyAt, NOW.toISOString());
    assert.deepEqual(r.s.files.map((f) => [f.path, f.role]).sort(), [[ANCHOR_PATH, "source"], [TEST_PATH, "test"]]);
    assert.equal(h.ws.workTreeText(ANCHOR_PATH), ANCHOR_ORIGINAL.replace(SEARCH, REPLACE));
    assert.equal(r.s.evidence.baseline?.total, BASELINE_TOTAL);
    assert.equal(r.s.evidence.reproBefore.length, 2);
    assert.equal(r.s.evidence.fixAfter.length, 2);
    assert.equal(r.s.evidence.suiteAfter?.total, BASELINE_TOTAL + 1);
    assert.equal(h.sandbox.remaining, 0);
    h.llm.assertAllConsumed();
  });

  test("test guard rejected once, then ok: the test author retries with the violations", async () => {
    const fixture = patchFixture(BASE, {
      insertBefore: { t1: [turn("t0", 1, testOutput(BAD_TEST_CONTENT))] },
      replace: { t1: { when: { ...repoKey, attempt: 2 } } },
    });
    const h = harness({ fixture, runs: [baselineRun(), reproRun(), reproRun(), fixPass(), fixPass(), suitePass()] });
    const r = await run(h);
    assertEnd(r, "patch_ready", null, "finalize");
    assert.equal(r.s.authorTestCalls, 2);
    assert.deepEqual(prompts(h), ["fix-test.v1", "fix-test.v1", "fix-patch.v1", "fix-review.v1"]);
    assert.deepEqual(io(h), [RUN_SUITE, WRITE_TEST, RUN_TEST, RUN_TEST, WRITE_SOURCE, RUN_TEST, RUN_TEST, RUN_SUITE]);
    const retry = h.llm.calls()[1]!;
    assert.equal(retry.matchKeys.attempt, 2);
    assertNoSourceWriteBeforeRepro(h);
    h.llm.assertAllConsumed();
  });

  test("test guard rejected twice gives up with guard_rejected, with nothing written or run (AC-68)", async () => {
    const fixture = patchFixture(BASE, {
      replace: { t1: { output: testOutput(BAD_TEST_CONTENT) } },
      remove: ["p1", "r1"],
      append: [turn("t2", 2, testOutput(BAD_TEST_CONTENT), { prompt: "fix-test.v1" })],
    });
    const h = harness({ fixture, runs: [baselineRun()] });
    const r = await run(h);
    assertEnd(r, "gave_up", "guard_rejected", "guard_test");
    assert.ok(r.s.violations.includes("test_not_importing_anchor"));
    assert.deepEqual(prompts(h), ["fix-test.v1", "fix-test.v1"]);
    assert.deepEqual(io(h), [RUN_SUITE]);
    assert.equal(r.s.suggestion?.reason, "guard_rejected");
    h.llm.assertAllConsumed();
  });

  test("repro wrong reason, then a retry at the same path, then ok (AC-69)", async () => {
    const fixture = patchFixture(BASE, {
      insertBefore: { t1: [turn("t0", 1, testOutput())] },
      replace: { t1: { when: { ...repoKey, attempt: 2 } } },
    });
    const wrong = () => failingRun([wrongFailure()]);
    const h = harness({ fixture, runs: [baselineRun(), wrong(), wrong(), reproRun(), reproRun(), fixPass(), fixPass(), suitePass()] });
    const r = await run(h);
    assertEnd(r, "patch_ready", null, "finalize");
    assert.equal(r.s.authorTestCalls, 2);
    assert.deepEqual(io(h), [
      RUN_SUITE, WRITE_TEST, RUN_TEST, RUN_TEST, WRITE_TEST, RUN_TEST, RUN_TEST, WRITE_SOURCE, RUN_TEST, RUN_TEST, RUN_SUITE,
    ]);
    assert.ok(h.llm.calls()[1]!.user.includes(TEST_PATH), "the retry is asked to reuse the test path");
    assertNoSourceWriteBeforeRepro(h);
    h.llm.assertAllConsumed();
  });

  test("a flaky repro gives up with repro_flaky and is not retried", async () => {
    const fixture = patchFixture(BASE, { remove: ["p1", "r1"] });
    const h = harness({ fixture, runs: [baselineRun(), reproRun(), fixPass()] });
    const r = await run(h);
    assertEnd(r, "gave_up", "repro_flaky", "repro");
    assert.deepEqual(prompts(h), ["fix-test.v1"]);
    assert.deepEqual(io(h), [RUN_SUITE, WRITE_TEST, RUN_TEST, RUN_TEST]);
    assert.equal(h.ws.workTreeText(ANCHOR_PATH), ANCHOR_ORIGINAL);
    h.llm.assertAllConsumed();
  });

  test("a patch that does not fix the test is retried once, then ok", async () => {
    const fixture = patchFixture(BASE, {
      insertBefore: { p1: [turn("p0", 1, patchOutput())] },
      replace: { p1: { when: { ...repoKey, attempt: 2 } } },
    });
    const notFixed = () => failingRun([rightFailure()]);
    const h = harness({ fixture, runs: [baselineRun(), reproRun(), reproRun(), notFixed(), notFixed(), fixPass(), fixPass(), suitePass()] });
    const r = await run(h);
    assertEnd(r, "patch_ready", null, "finalize");
    assert.equal(r.s.authorPatchCalls, 2);
    assert.deepEqual(prompts(h), ["fix-test.v1", "fix-patch.v1", "fix-patch.v1", "fix-review.v1"]);
    // The failed verify restores the source before the second patch is applied.
    assert.deepEqual(io(h), [
      RUN_SUITE, WRITE_TEST, RUN_TEST, RUN_TEST, WRITE_SOURCE, RUN_TEST, RUN_TEST, WRITE_SOURCE, WRITE_SOURCE, RUN_TEST, RUN_TEST, RUN_SUITE,
    ]);
    assert.equal(h.llm.calls()[2]!.matchKeys.attempt, 2);
    assert.equal(h.ws.workTreeText(ANCHOR_PATH), ANCHOR_ORIGINAL.replace(SEARCH, REPLACE));
    assertNoSourceWriteBeforeRepro(h);
    h.llm.assertAllConsumed();
  });

  test("a regressed suite gives up with suite_regressed and never reaches the reviewer (AC-71)", async () => {
    const fixture = patchFixture(BASE, { remove: ["r1"] });
    const broken = failingRun([rightFailure({ name: "other", file: "tests/checkout/cart.test.ts" })], { total: BASELINE_TOTAL + 1, passed: BASELINE_TOTAL });
    const h = harness({ fixture, runs: [baselineRun(), reproRun(), reproRun(), fixPass(), fixPass(), broken] });
    const r = await run(h);
    assertEnd(r, "gave_up", "suite_regressed", "verify");
    assert.deepEqual(prompts(h), ["fix-test.v1", "fix-patch.v1"]);
    assert.equal(r.s.patch, null);
    assert.equal(r.s.patchSha256, null);
    assertNoSourceWriteBeforeRepro(h);
    h.llm.assertAllConsumed();
  });

  test("a rejecting reviewer gives up with reviewer_rejected (AC-72)", async () => {
    const fixture = patchFixture(BASE, { replace: { r1: { output: { verdict: "reject", concerns: ["hides the error"] } } } });
    const h = harness({ fixture, runs: [baselineRun(), reproRun(), reproRun(), fixPass(), fixPass(), suitePass()] });
    const r = await run(h);
    assertEnd(r, "gave_up", "reviewer_rejected", "review");
    assert.equal(r.s.patchSha256, null);
    assert.equal(r.s.patchReadyAt, null);
    h.llm.assertAllConsumed();
  });

  test("an invalid reviewer output gives up with reviewer_unavailable (AC-72)", async () => {
    const fixture = patchFixture(BASE, { replace: { r1: { output: { verdict: "maybe", concerns: [] } } } });
    const h = harness({ fixture, runs: [baselineRun(), reproRun(), reproRun(), fixPass(), fixPass(), suitePass()] });
    const r = await run(h);
    assertEnd(r, "gave_up", "reviewer_unavailable", "review");
    assert.equal(r.s.review, null);
    h.llm.assertAllConsumed();
  });

  test("a spent token budget stops the retry before the second author call (AC-81)", async () => {
    const fixture = patchFixture(BASE, {
      replace: { t1: { output: testOutput(BAD_TEST_CONTENT), usage: { promptTokens: 59_000, completionTokens: 1_000 } } },
      remove: ["p1", "r1"],
    });
    const h = harness({ fixture, runs: [baselineRun()] });
    const r = await run(h);
    assertEnd(r, "gave_up", "budget_exhausted", "guard_test");
    assert.deepEqual(prompts(h), ["fix-test.v1"]);
    assert.equal(r.s.authorTestCalls, 1);
    assert.deepEqual(io(h), [RUN_SUITE]);
    h.llm.assertAllConsumed();
  });

  test("an aborted attempt gives up with attempt_timeout without throwing (AC-81)", async () => {
    const fixture = patchFixture(BASE, { remove: ["p1", "r1"] });
    const h = harness({ fixture, runs: [baselineRun(), reproRun()], onRun: (n, x) => { if (n === 2) x.abort.abort(); } });
    const r = await run(h);
    assertEnd(r, "gave_up", "attempt_timeout", "repro");
    assert.deepEqual(prompts(h), ["fix-test.v1"]);
    assert.deepEqual(io(h), [RUN_SUITE, WRITE_TEST, RUN_TEST]);
    assert.equal(h.ws.workTreeText(ANCHOR_PATH), ANCHOR_ORIGINAL);
    h.llm.assertAllConsumed();
  });
});

describe("the LLM is never called when the early pipeline fails (AC-61, AC-67)", () => {
  const empty = patchFixture(BASE, { remove: ["t1", "p1", "r1"] });

  test("ineligible: skipped, no connector query, no git, no LLM", async () => {
    const h = harness({ fixture: empty, runs: [], eligibility: { sandboxAvailable: false } });
    const r = await run(h);
    assertEnd(r, "skipped", "sandbox_unavailable", "eligibility");
    assert.deepEqual(r.stages, ["eligibility"]);
    assert.equal(h.query.calls.length, 0);
    assert.deepEqual(h.events, []);
    assert.equal(h.llm.calls().length, 0);
    h.llm.assertAllConsumed();
  });

  test("not locatable: skipped, no git, no LLM", async () => {
    const h = harness({ fixture: empty, runs: [], query: new FakeConnectorQuery({ errorEvent: null }) });
    const r = await run(h);
    assertEnd(r, "skipped", "error_event_unavailable", "locate");
    assert.deepEqual(h.events, []);
    assert.equal(h.ws.calls.length, 0);
    assert.equal(h.llm.calls().length, 0);
    h.llm.assertAllConsumed();
  });

  test("a red baseline: gave_up baseline_not_green, one suite run, no LLM", async () => {
    const h = harness({ fixture: empty, runs: [runSummary({ outcome: "failed", exitCode: 1, failed: 1, passed: 2 })] });
    const r = await run(h);
    assertEnd(r, "gave_up", "baseline_not_green", "baseline");
    assert.deepEqual(h.events, [RUN_SUITE]);
    assert.equal(h.llm.calls().length, 0);
    h.llm.assertAllConsumed();
  });

  test("a baseline timeout: gave_up baseline_timeout, no LLM", async () => {
    const h = harness({ fixture: empty, runs: [runSummary({ outcome: "timeout", exitCode: null })] });
    const r = await run(h);
    assertEnd(r, "gave_up", "baseline_timeout", "baseline");
    assert.equal(h.llm.calls().length, 0);
    h.llm.assertAllConsumed();
  });
});
