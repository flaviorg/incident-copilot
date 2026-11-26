// CodeFixService, CodeFixQueue, restart recovery and container wiring (spec 009, decisions 1 to 4, 16, 17 and 19;
// AC-60, AC-61, AC-66, AC-74, AC-75, AC-81 and AC-82). The real container and graph run over the in-memory fakes of
// tests/helpers/code-fix-fakes.ts and the strict fake LLM; no git, no child process, no network.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import type { CodeFixAttempt, NormalizedAlert, TestFailure } from "../../src/contracts/index.ts";
import { defineConnector } from "../../src/connectors/types.ts";
import type { ConnectorDefinition, QueryCapability } from "../../src/connectors/types.ts";
import type { CopilotConfig, CodeFixConfig } from "../../src/infra/copilot-config/schema.ts";
import { DEFAULT_INGEST } from "../../src/infra/copilot-config/schema.ts";
import { CODE_FIX_DEFAULT_LIMITS } from "../../src/domain/code-fix/limits.ts";
import type { CodeFixLimits } from "../../src/domain/code-fix/limits.ts";
import type { GitWorkspacePort, SandboxRunner, SandboxRunResult, Workspace } from "../../src/domain/code-fix/ports.ts";
import type { FixtureFile } from "../../src/llm/fixture-format.ts";
import { promptHash } from "../../src/llm/prompt-hash.ts";
import { fixPatchPrompt, fixReviewPrompt, fixTestPrompt } from "../../src/prompts/v1/index.ts";
import { openLiveIncidentRecord } from "../../src/app/live-setup.ts";
import { createCodeFixQueue } from "../../src/app/code-fix-queue.ts";
import type { CodeFixGraphNodes } from "../../src/graph/code-fix/graph.ts";
import {
  ALERT_STARTED_AT, ANCHOR_LINE, ANCHOR_PATH, failingRun, FakeCodeHostReader, FakeConnectorQuery, FakeSandboxRunner, runSummary,
  SAMPLE_REPO, sampleErrorEvent, sampleWorkspace,
} from "../helpers/code-fix-fakes.ts";
import type { FakeWorkspace } from "../helpers/code-fix-fakes.ts";
import { patchFixture } from "../helpers/fixtures.ts";
import { readFileSync } from "node:fs";
import { buildServer } from "../../src/http/server.ts";
import { alertmanagerConnector } from "../../src/connectors/alertmanager/index.ts";
import { liveCopilot } from "../helpers/live.ts";
import { createFakeTelemetryConnector } from "../helpers/fake-telemetry-connector.ts";
import { createFakeNotifier } from "../helpers/fake-notifier.ts";
import { createTestContainer } from "../helpers/container.ts";
import type { TestContainer } from "../helpers/container.ts";

// ---------- facts (as in tests/unit/code-fix-graph.unit.test.ts) ----------

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
const SEARCH = "  return cart.totals.total;";
const REPLACE = "  return cart.totals?.total ?? 0;";
const BASELINE_TOTAL = 3;

const rightFailure = (): TestFailure => ({
  name: TEST_NAME, file: TEST_PATH, errorName: "TypeError", message: "Cannot read properties of undefined (reading 'total')",
  frames: [{ file: ANCHOR_PATH, line: ANCHOR_LINE }, { file: TEST_PATH, line: 6 }],
});
const baselineRun = () => runSummary({ total: BASELINE_TOTAL, passed: BASELINE_TOTAL });
const happyRuns = (): SandboxRunResult[] => [
  baselineRun(), failingRun([rightFailure()]), failingRun([rightFailure()]), runSummary({ total: 1, passed: 1 }), runSummary({ total: 1, passed: 1 }),
  runSummary({ total: BASELINE_TOTAL + 1, passed: BASELINE_TOTAL + 1 }),
];
const redBaseline = () => [runSummary({ outcome: "failed", exitCode: 1, failed: 1, passed: 2 })];

const repoKey = { repo: SAMPLE_REPO.repo };
const FIXTURE: FixtureFile = {
  schemaVersion: 1,
  scenarioId: "live:sentry",
  promptHashes: {
    [fixTestPrompt.version]: promptHash(fixTestPrompt),
    [fixPatchPrompt.version]: promptHash(fixPatchPrompt),
    [fixReviewPrompt.version]: promptHash(fixReviewPrompt),
  },
  turns: [
    { id: "t1", prompt: "fix-test.v1", when: { ...repoKey, attempt: 1 }, output: { test: { path: TEST_PATH, content: TEST_CONTENT }, rationale: "Calls summarize without totals." } },
    { id: "p1", prompt: "fix-patch.v1", when: { ...repoKey, attempt: 1 }, output: { edits: [{ path: ANCHOR_PATH, search: SEARCH, replace: REPLACE }], rationale: "Guards the totals." } },
    { id: "r1", prompt: "fix-review.v1", when: repoKey, output: { verdict: "approve", concerns: [] } },
  ],
};
const NO_TURNS = patchFixture(FIXTURE, { remove: ["t1", "p1", "r1"] });

/** A GitHub-token-shaped secret, built at run time (AGENTS.md). */
const SECRET = "ghp_" + "Q7".repeat(18);

// ---------- harness ----------

/** A query connector registered under type `sentry` (the loader requires that type) over a FakeConnectorQuery. */
function fakeSentry(query: () => FakeConnectorQuery): ConnectorDefinition<unknown> {
  return defineConnector({
    type: "sentry",
    displayName: "Fake Sentry (tests)",
    capabilities: ["query"],
    configSchema: () => z.strictObject({}),
    create: (_c, d) => {
      const q = query();
      const cap: QueryCapability = {
        metricNames: [],
        ...(q.errorEvent ? { errorEvent: q.errorEvent } : {}),
        ...(q.deploys ? { deploys: q.deploys } : {}),
        ...(q.releaseCommit ? { releaseCommit: q.releaseCommit } : {}),
      };
      return { id: d.id, type: "sentry", ingest: null, query: cap };
    },
  });
}

function codeFixConfig(over: Partial<CodeFixConfig> = {}, limits: Partial<CodeFixLimits> = {}): CodeFixConfig {
  return {
    enabled: true,
    mode: "shadow",
    approvalTtlHours: 72,
    sandbox: { network: "isolated" },
    github: { apiUrl: "https://api.github.com", token: SECRET },
    commitAuthor: { name: "incident-copilot", email: "incident-copilot@example.invalid" },
    limits: { ...CODE_FIX_DEFAULT_LIMITS, ...limits },
    fixableExceptionTypes: ["TypeError", "RangeError", "ReferenceError"],
    repositories: [{ ...SAMPLE_REPO }],
    ...over,
  };
}

function copilotWith(codeFix: CodeFixConfig | null): CopilotConfig {
  return {
    version: 1, mode: "shadow", publicUrl: null, ingest: { ...DEFAULT_INGEST },
    services: [{ name: "checkout-web", aliases: {} }],
    connectors: [{ id: "sentry", type: "sentry", enabled: true, severityMap: null, capabilities: ["query"], config: {} }],
    notifiers: [], codeFix, secrets: [SECRET],
  };
}

/** A workspace port that hands out a fresh in-memory workspace per attempt and remembers each one. */
class FreshWorkspaces implements GitWorkspacePort {
  readonly made: FakeWorkspace[] = [];
  private readonly fail: Error | null;
  constructor(fail: Error | null = null) {
    this.fail = fail;
  }
  async prepare(): Promise<Workspace> {
    if (this.fail) throw this.fail;
    const ws = sampleWorkspace();
    this.made.push(ws);
    return ws;
  }
}

type Setup = {
  c: TestContainer;
  workspaces: FreshWorkspaces;
  reader: FakeCodeHostReader;
  sandboxes: FakeSandboxRunner[];
  query: FakeConnectorQuery;
  published: string[];
};

function setup(o: {
  fixture?: FixtureFile;
  runs?: () => SandboxRunResult[];
  codeFix?: Partial<CodeFixConfig>;
  limits?: Partial<CodeFixLimits>;
  selfTestOk?: boolean;
  workspaceError?: Error;
  query?: () => FakeConnectorQuery;
  nodes?: Partial<CodeFixGraphNodes>;
  dbPath?: string;
  workspaceRoot?: string;
  onSelfTest?: () => void;
} = {}): Setup {
  const workspaces = new FreshWorkspaces(o.workspaceError ?? null);
  const reader = new FakeCodeHostReader();
  const sandboxes: FakeSandboxRunner[] = [];
  const published: string[] = [];
  let query = new FakeConnectorQuery();
  const c = createTestContainer({
    fixture: o.fixture ?? FIXTURE,
    copilot: copilotWith(codeFixConfig(o.codeFix, o.limits)),
    connectorDefinitions: [fakeSentry(() => (query = o.query ? o.query() : new FakeConnectorQuery()))],
    ...(o.dbPath ? { dbPath: o.dbPath } : {}),
    codeFixPorts: {
      workspace: workspaces,
      reader,
      sandbox: (): SandboxRunner => {
        const s = new FakeSandboxRunner(o.runs ? o.runs() : happyRuns());
        sandboxes.push(s);
        return s;
      },
      selfTest: async () => {
        o.onSelfTest?.();
        return { ok: o.selfTestOk ?? true };
      },
      publish: async (id: string) => void published.push(id),
      ...(o.workspaceRoot ? { workspaceRoot: o.workspaceRoot } : {}),
    },
    ...(o.nodes ? { codeFixNodes: o.nodes } : {}),
  });
  return { c, workspaces, reader, sandboxes, query, published };
}

/** A live incident persisted the way an analysis_ready run leaves it: advised, with a bad_deploy diagnosis. */
function advisedIncident(c: TestContainer, o: {
  issueId?: string; status?: "advised" | "escalated"; category?: "bad_deploy" | "capacity"; confidence?: "low" | "medium" | "high";
  source?: string; fingerprint?: string;
} = {}): string {
  const alert: NormalizedAlert = {
    source: o.source ?? "sentry", externalId: `ev-${Math.random().toString(36).slice(2)}`, fingerprint: o.fingerprint ?? `issue:${o.issueId ?? "4815162342"}`,
    service: "checkout-web", title: "TypeError in summarize", severity: "sev2", status: "firing", startedAt: ALERT_STARTED_AT, url: null,
    signal: "error_events", attributes: {},
  };
  // A later alert of the same group opens a new incident once the earlier one is closed (the stale or resolved path).
  const open = c.store.findOpenLiveIncident("sentry", alert.fingerprint);
  if (open) c.store.closeLiveIncident(open.incidentId, ALERT_STARTED_AT);
  const { id } = c.store.recordIngestedAlert({ connectorId: "sentry", alert, receivedAt: ALERT_STARTED_AT, requestId: null });
  const rec = c.store.getIngestedAlert(id)!;
  const { incident, blackboard, version } = openLiveIncidentRecord({ store: c.store, clock: c.clock, ids: c.ids }, rec, { requestId: null });
  c.store.saveBlackboard(incident.id, {
    ...blackboard,
    diagnosis: {
      hypothesis: "The latest deploy broke cart totals", category: o.category ?? "bad_deploy", confidence: o.confidence ?? "high",
      evidence: [{ source: "errors", ref: "errors:checkout-web:4815162342", summary: "new TypeError after the deploy" }], capReached: false,
    },
  }, version);
  c.store.updateIncidentStatus(incident.id, o.status ?? "advised", {});
  return incident.id;
}

const fixes = (c: TestContainer) => c.codeFix!.store;
const latest = (c: TestContainer, id: string): CodeFixAttempt => {
  const a = fixes(c).latestForIncident(id);
  assert.ok(a, "an attempt row exists");
  return a;
};
const auditEvents = (c: TestContainer, id: string) => c.store.listAudit(id).map((e) => e.event).filter((e) => e.startsWith("code_fix_") || e.startsWith("approval_"));

async function considerAndWait(c: TestContainer, id: string): Promise<CodeFixAttempt> {
  c.codeFix!.consider(id);
  await c.codeFix!.idle();
  return latest(c, id);
}

// =====================================================================================================================

describe("CodeFixQueue", () => {
  test("runs jobs with the given concurrency, never lets a failing job stop it, and reports idle", async () => {
    const logs: string[] = [];
    const logger = { error: (m: string) => void logs.push(m), warn: () => {}, info: () => {}, debug: () => {}, child: () => logger } as never;
    const q = createCodeFixQueue({ concurrency: 1, logger });
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const job = (n: number, fail = false) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      order.push(n);
      active -= 1;
      if (fail) throw new Error("boom");
    };
    q.enqueue(job(1, true));
    q.enqueue(job(2));
    q.enqueue(job(3));
    assert.equal(q.size(), 3);
    await q.idle();
    assert.deepEqual(order, [1, 2, 3]);
    assert.equal(maxActive, 1);
    assert.equal(q.size(), 0);
    assert.equal(logs.length, 1);
  });

  test("concurrency 2 runs two at once", async () => {
    const q = createCodeFixQueue({ concurrency: 2, logger: { error: () => {} } as never });
    let active = 0;
    let maxActive = 0;
    for (let i = 0; i < 4; i++) {
      q.enqueue(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      });
    }
    await q.idle();
    assert.equal(maxActive, 2);
  });
});

describe("container wiring", () => {
  test("without codeFix (or disabled) there is no fixer", () => {
    assert.equal(createTestContainer().codeFix, null);
    const c = createTestContainer({ copilot: copilotWith(codeFixConfig({ enabled: false })), connectorDefinitions: [fakeSentry(() => new FakeConnectorQuery())] });
    assert.equal(c.codeFix, null);
  });

  test("an enabled codeFix exposes the service", () => {
    const { c } = setup();
    assert.ok(c.codeFix);
    assert.equal(typeof c.codeFix.consider, "function");
  });
});

describe("consider: eligibility inline, no LLM and no git on a skip (AC-61)", () => {
  test("returns immediately and never throws, even when the store throws", async () => {
    const { c, workspaces } = setup({ fixture: NO_TURNS });
    const id = advisedIncident(c);
    c.store.loadBlackboard = () => {
      throw new Error("database is gone");
    };
    assert.equal(c.codeFix!.consider(id), undefined);
    await c.codeFix!.idle();
    assert.equal(fixes(c).latestForIncident(id), null);
    assert.equal(workspaces.made.length, 0);
    assert.ok(c.logs.some((l) => l.includes("code_fix_consider_failed")));
  });

  for (const [name, o, reason] of [
    ["escalated", { status: "escalated" }, "not_advised"],
    ["not a Sentry issue", { fingerprint: "group:abc" }, "source_unsupported"],
    ["not bad_deploy", { category: "capacity" }, "category_not_code"],
    ["low confidence", { confidence: "low" }, "low_confidence"],
  ] as const) {
    test(`${name}: skipped/${reason}, audit code_fix_skipped, no key`, async () => {
      const { c, workspaces, query } = setup({ fixture: NO_TURNS });
      const id = advisedIncident(c, o);
      const a = await considerAndWait(c, id);
      assert.equal(a.status, "skipped");
      assert.equal(a.reason, reason);
      assert.deepEqual(auditEvents(c, id), ["code_fix_skipped"]);
      const skip = c.store.listAudit(id).find((e) => e.event === "code_fix_skipped")!;
      assert.equal(skip.actor, "agent:code_fixer");
      assert.equal(skip.tier, null);
      assert.deepEqual(Object.keys(skip.details).sort(), ["attemptId", "reason", "requestId"]);
      assert.equal(skip.details.attemptId, a.id);
      assert.equal(fixes(c).holdsKey(a.repo, a.errorGroupId), false);
      assert.equal(workspaces.made.length, 0);
      assert.equal(query.calls.length, 0);
      assert.equal(c.fake.calls().length, 0);
    });
  }

  test("a failed self-test in isolated mode skips every eligible incident with sandbox_unavailable (AC-66)", async () => {
    const { c, workspaces, query } = setup({ fixture: NO_TURNS, selfTestOk: false });
    const first = advisedIncident(c);
    const second = advisedIncident(c, { issueId: "99" });
    for (const id of [first, second]) {
      const a = await considerAndWait(c, id);
      assert.equal(a.status, "skipped");
      assert.equal(a.reason, "sandbox_unavailable");
    }
    assert.equal(workspaces.made.length, 0);
    assert.equal(query.calls.length, 0);
    assert.equal(c.fake.calls().length, 0);
  });
});

describe("an attempt in shadow mode (AC-60, AC-74)", () => {
  test("takes the key, runs outside the incident and ends patch_ready with only commitExists on the code host", async () => {
    const { c, reader, workspaces } = setup();
    const id = advisedIncident(c);
    const before = c.store.loadBlackboard(id);
    const statusBefore = c.store.getIncident(id)!.status;
    let slots = 0;
    const acquire = c.runSlots.acquire;
    const tryAcquire = c.runSlots.tryAcquire;
    c.runSlots.acquire = () => { slots += 1; return acquire(); };
    c.runSlots.tryAcquire = () => { slots += 1; return tryAcquire(); };

    const a = await considerAndWait(c, id);

    assert.equal(a.status, "patch_ready");
    assert.equal(a.reason, null);
    assert.equal(a.stage, "finalize");
    assert.equal(a.mode, "shadow");
    assert.equal(a.isolation, "isolated");
    assert.match(a.id, /^fix_[a-z0-9]{8,40}$/);
    assert.match(a.patchSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(a.commitSha, "3f786850e387550fdab836ed7e6dc881de23001b");
    assert.equal(a.baseCommitSha, "b".repeat(40));
    assert.equal(a.evidence.baseline?.total, BASELINE_TOTAL);
    assert.equal(a.evidence.reproBefore.length, 2);
    assert.equal(a.llm.calls, 3);
    assert.ok(a.patchReadyAt);
    assert.ok(a.finishedAt);
    assert.equal(fixes(c).holdsKey(a.repo, a.errorGroupId), true);

    // AC-60: the incident is untouched and no run slot or runs row was used.
    const after = c.store.loadBlackboard(id);
    assert.equal(after.version, before.version);
    assert.deepEqual(after.blackboard, before.blackboard);
    assert.equal(c.store.getIncident(id)!.status, statusBefore);
    assert.deepEqual(c.store.listRuns(id), []);
    assert.equal(slots, 0);

    // AC-74: no write request; the reader saw only commitExists.
    assert.ok(reader.calls.length > 0);
    assert.deepEqual([...new Set(reader.calls.map((x) => x.method))], ["commitExists"]);

    assert.deepEqual(auditEvents(c, id), ["code_fix_started", "code_fix_patch_ready"]);
    const started = c.store.listAudit(id).find((e) => e.event === "code_fix_started")!;
    assert.equal(started.actor, "agent:code_fixer");
    assert.equal(started.details.attemptId, a.id);
    assert.equal(started.details.repo, SAMPLE_REPO.repo);
    assert.equal(started.details.isolation, "isolated");
    const ready = c.store.listAudit(id).find((e) => e.event === "code_fix_patch_ready")!;
    assert.equal(ready.tier, 3);
    assert.equal(ready.details.patchSha256, a.patchSha256);
    assert.equal(ready.details.mode, "shadow");

    // Trace: agent code_fixer, runId = attemptId.
    const trace = c.store.listTrace(id).filter((e) => e.agent === "code_fixer");
    assert.ok(trace.length > 0);
    assert.ok(trace.every((e) => e.runId === a.id));
    assert.ok(trace.some((e) => e.type === "action") && trace.some((e) => e.type === "observation"));

    // LLM calls go through the recording provider with runId = attemptId.
    const calls = c.store.listLlmCalls(id);
    assert.deepEqual(calls.map((x) => x.promptVersion), ["fix-test.v1", "fix-patch.v1", "fix-review.v1"]);
    assert.ok(calls.every((x) => x.runId === a.id));
    c.fake.assertAllConsumed({ scenarioId: "live:sentry" });

    assert.equal(workspaces.made.length, 1);
    assert.equal(workspaces.made[0]!.disposed, true);
    assert.equal(c.store.listApprovals({ incidentId: id }).length, 0);
    assert.equal(fixes(c).listApprovals({ incidentId: id }).length, 0);
  });

  test("two attempts are serialized on the queue (maxConcurrent 1)", async () => {
    let active = 0;
    let maxActive = 0;
    const { c } = setup({
      fixture: NO_TURNS,
      nodes: {
        fix_workspace: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 10));
          active -= 1;
          return { stage: "workspace", failure: "workspace_failed" };
        },
      },
    });
    const first = advisedIncident(c);
    const second = advisedIncident(c, { issueId: "99" });
    c.codeFix!.consider(first);
    c.codeFix!.consider(second);
    await c.codeFix!.idle();
    assert.equal(maxActive, 1);
    assert.equal(latest(c, first).status, "gave_up");
    assert.equal(latest(c, second).status, "gave_up");
  });

  test("all audit, trace, log and stored attempt text is redacted", async () => {
    const event = sampleErrorEvent({ exception: { type: "TypeError", value: `Cannot read properties of undefined (token ${SECRET})` } });
    const { c } = setup({ query: () => new FakeConnectorQuery({ errorEvent: event }) });
    const id = advisedIncident(c);
    const a = await considerAndWait(c, id);
    assert.equal(a.status, "patch_ready");
    assert.ok(!JSON.stringify(a).includes(SECRET), "attempt row");
    assert.ok(!JSON.stringify(c.store.listAudit(id)).includes(SECRET), "audit");
    assert.ok(!JSON.stringify(c.store.listTrace(id)).includes(SECRET), "trace");
    assert.ok(!c.logs.join("\n").includes(SECRET), "logs");
  });
});

describe("draft_pr mode (AC-75)", () => {
  test("one transaction stores the code-fix approval, moves the attempt to awaiting_approval and audits approval_requested", async () => {
    const { c, reader } = setup({ codeFix: { mode: "draft_pr", approvalTtlHours: 48 } });
    const id = advisedIncident(c);
    const a = await considerAndWait(c, id);
    assert.equal(a.status, "awaiting_approval");
    assert.equal(a.mode, "draft_pr");
    const approvals = fixes(c).listApprovals({ incidentId: id });
    assert.equal(approvals.length, 1);
    const ap = approvals[0]!;
    assert.equal(ap.status, "pending");
    assert.equal(ap.subject, "code_fix");
    assert.equal(ap.actionId, a.id);
    assert.equal(ap.patchSha256, a.patchSha256);
    assert.equal(a.approvalId, ap.id);
    assert.equal(Date.parse(ap.expiresAt) - Date.parse(ap.requestedAt), 48 * 3_600_000);
    assert.deepEqual(c.store.listApprovals({ incidentId: id }), []);

    assert.deepEqual(auditEvents(c, id), ["code_fix_started", "code_fix_patch_ready", "approval_requested"]);
    const req = c.store.listAudit(id).find((e) => e.event === "approval_requested")!;
    assert.equal(req.tier, 3);
    assert.equal(req.actor, "agent:code_fixer");
    assert.deepEqual(
      { subject: req.details.subject, approvalId: req.details.approvalId, attemptId: req.details.attemptId, patchSha256: req.details.patchSha256, expiresAt: req.details.expiresAt },
      { subject: "code_fix", approvalId: ap.id, attemptId: a.id, patchSha256: a.patchSha256, expiresAt: ap.expiresAt },
    );
    assert.deepEqual([...new Set(reader.calls.map((x) => x.method))], ["commitExists"]);
  });
});

describe("the per-group key and the caps (AC-82)", () => {
  test("a permanent give-up keeps the key: the next alert of the group is skipped already_attempted", async () => {
    const { c } = setup({ fixture: NO_TURNS, runs: redBaseline });
    const first = advisedIncident(c);
    const a = await considerAndWait(c, first);
    assert.equal(a.status, "gave_up");
    assert.equal(a.reason, "baseline_not_green");
    assert.equal(fixes(c).holdsKey(a.repo, a.errorGroupId), true);
    assert.deepEqual(auditEvents(c, first), ["code_fix_started", "code_fix_gave_up"]);
    const gaveUp = c.store.listAudit(first).find((e) => e.event === "code_fix_gave_up")!;
    assert.equal(gaveUp.details.reason, "baseline_not_green");
    assert.equal(gaveUp.details.stage, "baseline");

    const second = advisedIncident(c);
    const b = await considerAndWait(c, second);
    assert.equal(b.status, "skipped");
    assert.equal(b.reason, "already_attempted");
  });

  test("a transient give-up releases the key, until maxAttemptsPerGroup attempts exist", async () => {
    const { c } = setup({ fixture: NO_TURNS, workspaceError: new Error("fetch failed"), limits: { maxAttemptsPerGroup: 2 } });
    const results: CodeFixAttempt[] = [];
    for (let i = 0; i < 3; i++) results.push(await considerAndWait(c, advisedIncident(c)));
    assert.deepEqual(results.map((r) => [r.status, r.reason]), [["gave_up", "workspace_failed"], ["gave_up", "workspace_failed"], ["skipped", "already_attempted"]]);
    assert.equal(fixes(c).holdsKey(results[0]!.repo, results[0]!.errorGroupId), false);
  });

  test("maxAttemptsPerDay caps a repository across error groups", async () => {
    const { c } = setup({ fixture: NO_TURNS, runs: redBaseline, limits: { maxAttemptsPerDay: 1 } });
    const a = await considerAndWait(c, advisedIncident(c, { issueId: "1" }));
    const b = await considerAndWait(c, advisedIncident(c, { issueId: "2" }));
    assert.equal(a.status, "gave_up");
    assert.deepEqual([b.status, b.reason], ["skipped", "daily_cap_reached"]);
  });
});

describe("failures never reach the queue, and the workspace is always disposed (AC-81)", () => {
  test("a node that throws ends the attempt gave_up, releases the key and disposes the workspace", async () => {
    const { c, workspaces } = setup({ fixture: NO_TURNS, nodes: { fix_baseline: async () => { throw new Error(`boom ${SECRET}`); } } });
    const id = advisedIncident(c);
    const a = await considerAndWait(c, id);
    assert.equal(a.status, "gave_up");
    assert.equal(a.reason, "sandbox_error");
    assert.ok(a.finishedAt);
    assert.equal(fixes(c).holdsKey(a.repo, a.errorGroupId), false);
    assert.equal(workspaces.made.length, 1);
    assert.equal(workspaces.made[0]!.disposed, true);
    assert.ok(!c.logs.join("\n").includes(SECRET));
    // The queue keeps working.
    const next = await considerAndWait(c, advisedIncident(c, { issueId: "77" }));
    assert.equal(next.status, "gave_up");
  });

  test("a locate failure ends skipped without the key; a give-up after the workspace disposes it", async () => {
    const { c, workspaces } = setup({ fixture: NO_TURNS, query: () => new FakeConnectorQuery({ errorEvent: null }) });
    const id = advisedIncident(c);
    const a = await considerAndWait(c, id);
    assert.deepEqual([a.status, a.reason, a.stage], ["skipped", "error_event_unavailable", "locate"]);
    assert.equal(fixes(c).holdsKey(a.repo, a.errorGroupId), false);
    assert.deepEqual(auditEvents(c, id), ["code_fix_started", "code_fix_skipped"]);
    assert.equal(workspaces.made.length, 0);

    const s2 = setup({ fixture: NO_TURNS, runs: redBaseline });
    await considerAndWait(s2.c, advisedIncident(s2.c));
    assert.equal(s2.workspaces.made[0]!.disposed, true);
  });

  test("an attempt over its time budget gives up with attempt_timeout and releases the key", async () => {
    const { c } = setup({
      fixture: NO_TURNS,
      limits: { attemptTimeoutMin: 1 },
      nodes: {
        // Stands in for a node that sees the attempt's signal fire: it is aborted by the time it returns.
        fix_baseline: async (_s, cfg) => {
          assert.ok(cfg?.signal, "the node receives the attempt signal");
          return { stage: "baseline", failure: "attempt_timeout" };
        },
      },
    });
    const a = await considerAndWait(c, advisedIncident(c));
    assert.deepEqual([a.status, a.reason], ["gave_up", "attempt_timeout"]);
    assert.equal(fixes(c).holdsKey(a.repo, a.errorGroupId), false);
  });
});

describe("restart recovery (decision 2, AC-81)", () => {
  const row = (incidentId: string, over: Partial<CodeFixAttempt>): CodeFixAttempt => ({
    id: "fix_aaaaaaaa", incidentId, repo: SAMPLE_REPO.repo, service: SAMPLE_REPO.service, connectorId: "sentry", errorGroupId: "4815162342",
    mode: "shadow", isolation: "isolated", status: "running", stage: "baseline", reason: null, violations: [], release: null, commitSha: null,
    baseBranch: "main", baseCommitSha: null, exception: null, anchor: null, files: [], patch: null, patchSha256: null, contents: [],
    evidence: { baseline: null, reproBefore: [], fixAfter: [], suiteAfter: null }, review: null, suggestion: null, approvalId: null, commit: null,
    pullRequest: null, llm: { calls: 0, promptTokens: 0, completionTokens: 0 }, startedAt: ALERT_STARTED_AT, patchReadyAt: null, finishedAt: null,
    version: 1, ...over,
  });

  test("on start, running ends gave_up/interrupted with the key released and publishing is re-enqueued", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ic-fix-recover-"));
    try {
      const dbPath = join(dir, "copilot.db");
      const first = setup({ fixture: NO_TURNS, dbPath });
      const id = advisedIncident(first.c);
      fixes(first.c).insertAttempt(row(id, {}), { keyHeld: true });
      fixes(first.c).insertAttempt(row(id, { id: "fix_bbbbbbbb", errorGroupId: "5", status: "publishing", stage: "publish" }), { keyHeld: true });
      first.c.close();

      const second = setup({ fixture: NO_TURNS, dbPath });
      await second.c.codeFix!.idle();
      const running = fixes(second.c).getAttempt("fix_aaaaaaaa")!;
      assert.deepEqual([running.status, running.reason], ["gave_up", "interrupted"]);
      assert.ok(running.finishedAt);
      assert.equal(fixes(second.c).holdsKey(SAMPLE_REPO.repo, "4815162342"), false);
      assert.deepEqual(second.published, ["fix_bbbbbbbb"]);
      const audit = second.c.store.listAudit(id).filter((e) => e.event === "code_fix_gave_up");
      assert.equal(audit.length, 1);
      assert.equal(audit[0]!.details.reason, "interrupted");
      second.c.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("on start, stale ic-fix-* attempt directories under the workspace root are removed before the self-test", async () => {
    const root = mkdtempSync(join(tmpdir(), "ic-sweep-"));
    const outside = mkdtempSync(join(tmpdir(), "ic-sweep-outside-"));
    try {
      const hourAgo = new Date(Date.now() - 3_600_000);
      const inAnHour = new Date(Date.now() + 3_600_000);
      const dir = (name: string, at: Date): string => {
        const d = join(root, name);
        mkdirSync(join(d, "repo"), { recursive: true });
        writeFileSync(join(d, "repo", "secret.ts"), "private source\n");
        utimesSync(d, at, at);
        return d;
      };
      // A crashed attempt of a previous process: left behind, older than this start.
      const stale = dir("ic-fix-AbC123", hourAgo);
      // Created after this process started: never ours to remove.
      const fresh = dir("ic-fix-Zz9999", inAnHour);
      // Not an attempt directory (mkdtemp adds exactly six characters to "ic-fix-").
      const other = dir("ic-fix-recover-abc123", hourAgo);
      const unrelated = dir("unrelated", hourAgo);
      writeFileSync(join(outside, "keep.txt"), "keep\n");
      const link = join(root, "ic-fix-LnK000");
      symlinkSync(outside, link);
      let staleAtSelfTest: boolean | null = null;
      const { c } = setup({ fixture: NO_TURNS, workspaceRoot: root, onSelfTest: () => void (staleAtSelfTest = existsSync(stale)) });
      await c.codeFix!.start();
      assert.equal(existsSync(stale), false, "the stale attempt directory is removed");
      assert.equal(staleAtSelfTest, false, "before the self-test runs");
      for (const kept of [fresh, other, unrelated, link]) assert.ok(existsSync(kept), kept);
      assert.ok(existsSync(join(outside, "keep.txt")), "a symlink is never followed");
      c.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("recover() is idempotent and never throws", async () => {
    const { c } = setup({ fixture: NO_TURNS });
    const id = advisedIncident(c);
    fixes(c).insertAttempt(row(id, {}), { keyHeld: true });
    c.codeFix!.recover();
    c.codeFix!.recover();
    await c.codeFix!.idle();
    assert.deepEqual([latest(c, id).status, latest(c, id).reason], ["gave_up", "interrupted"]);
    assert.equal(c.store.listAudit(id).filter((e) => e.event === "code_fix_gave_up").length, 1);
  });
});

describe("the alert job's follow-up (decision 1, AC-60)", () => {
  test("an analysis_ready run calls consider after its notification, outside the run slot", async () => {
    const AM_TOKEN = "am-live-" + "k".repeat(30);
    const telemetry = createFakeTelemetryConnector();
    const notifier = createFakeNotifier();
    const defs = [alertmanagerConnector, telemetry.definition];
    const base = liveCopilot(`
version: 1
mode: shadow
services:
  - name: checkout-api
    aliases: { prom: [checkout] }
connectors:
  - id: prom
    type: alertmanager
    ingest: { auth: { type: bearer, token: "\${AM_TOKEN}" } }
  - id: fake
    type: fake-telemetry
notifiers:
  - id: team
    type: fake-notifier
`, { env: { AM_TOKEN }, connectors: defs, notifiers: [notifier.definition] });
    const copilot: CopilotConfig = {
      ...base,
      codeFix: codeFixConfig({ repositories: [{ ...SAMPLE_REPO, service: "checkout-api", connector: "fake" }] }),
    };
    const c = createTestContainer({
      copilot, connectorDefinitions: defs, notifierDefinitions: [notifier.definition], fixture: "tests/fixtures/llm/live-prom.json", sleep: async () => {},
      codeFixPorts: { workspace: new FreshWorkspaces(), reader: new FakeCodeHostReader(), sandbox: () => new FakeSandboxRunner([]), selfTest: async () => ({ ok: true }) },
    });
    const seen: { id: string; notified: string[]; slots: number }[] = [];
    const consider = c.codeFix!.consider.bind(c.codeFix!);
    c.codeFix!.consider = (id, ctx) => {
      seen.push({ id, notified: notifier.messages.map((m) => m.kind), slots: c.runSlots.inUse() });
      consider(id, ctx);
    };
    const res = await buildServer(c).inject({
      method: "POST", url: "/ingest/prom", payload: readFileSync("tests/fixtures/connectors/alertmanager/firing.json", "utf8"),
      headers: { "content-type": "application/json", authorization: `Bearer ${AM_TOKEN}` },
    });
    assert.equal(res.statusCode, 202);
    await c.alertQueue.idle();
    await c.codeFix!.idle();
    const id = c.store.listIncidents({ limit: 1 })[0]!.id;
    assert.equal(c.store.getIncident(id)!.status, "advised");
    assert.deepEqual(seen, [{ id, notified: ["incident_opened", "analysis_ready"], slots: 0 }]);
    // An Alertmanager incident is not a Sentry issue: recorded as skipped, nothing else.
    const a = latest(c, id);
    assert.deepEqual([a.status, a.reason], ["skipped", "source_unsupported"]);
  });
});
