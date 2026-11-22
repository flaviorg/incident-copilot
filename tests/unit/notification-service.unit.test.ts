// Notifications (spec 008, decision 14; AC-56): built from the read model with catalog tiers, redacted, sent to the
// subscribed notifiers with one retry, never throwing. Also proves the notifier conformance kit on a tiny HTTP notifier.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import { buildCodeFixNotificationMessage, buildNotificationMessage } from "../../src/app/notification-message.ts";
import { createNotificationService } from "../../src/app/notification-service.ts";
import { createIncidentContextResolver } from "../../src/app/incident-context.ts";
import { DEFAULT_NOTIFICATION_EVENTS, defineNotifier } from "../../src/notifiers/types.ts";
import type { Notifier, NotificationMessage, NotifyOutcome } from "../../src/notifiers/types.ts";
import { ConnectorError } from "../../src/connectors/shared/errors.ts";
import { createLogger } from "../../src/infra/logger.ts";
import type { Approval, CodeFixAttempt, IncidentView, TestRunSummary } from "../../src/contracts/index.ts";
import { defineConnector } from "../../src/connectors/types.ts";
import type { ConnectorDefinition } from "../../src/connectors/types.ts";
import type { CodeFixConfig, CopilotConfig } from "../../src/infra/copilot-config/schema.ts";
import { DEFAULT_INGEST } from "../../src/infra/copilot-config/schema.ts";
import { CODE_FIX_DEFAULT_LIMITS } from "../../src/domain/code-fix/limits.ts";
import { FakeCodeHostReader, FakeGitWorkspace, FakeSandboxRunner, SAMPLE_REPO } from "../helpers/code-fix-fakes.ts";
import { createTestContainer, initialBlackboard, TEST_APPROVAL_TOKEN } from "../helpers/container.ts";
import type { TestContainer } from "../helpers/container.ts";
import { createFakeNotifier, FAKE_NOTIFIER_TYPE } from "../helpers/fake-notifier.ts";
import { act } from "../helpers/blackboard.ts";
import { describeNotifierConformance } from "../helpers/notifier-conformance.ts";

const SECRET = "notify-secret-" + "n".repeat(20);
const origin = { kind: "connector" as const, connectorId: "prom", source: "alertmanager", fingerprint: "fp", alertId: "ALR-0001", externalUrl: "https://prom.example.com/x", mode: "shadow" as const };

function view(over: Partial<IncidentView["incident"]> = {}): IncidentView {
  return {
    incident: {
      id: "INC-0001", title: `High error rate ${SECRET}`, service: "checkout-api", severity: "sev1", status: "advised", scenarioId: "live:prom",
      openedAt: "2026-10-04T09:41:30.000Z", impactStartedAt: "2026-10-04T09:41:30.000Z", detectedAt: "2026-10-04T09:41:30.000Z", resolvedAt: null, escalation: null, ...over,
    },
    diagnosis: { hypothesis: "bad deploy", category: "bad_deploy", confidence: "high", evidence: [{ source: "errors", ref: "errors:x", summary: "s" }], capReached: false },
    runbookMatches: [], plan: null, planRevision: 0, audit: null,
    actions: [
      act("blocked_forbidden", { id: "ACT-0003", order: 3, actionType: "run_arbitrary_command", tier: 4 }),
      act("recommended", { id: "ACT-0001", order: 1, tier: 3 }),
      act("recommended", { id: "ACT-0002", order: 2, actionType: "add_incident_note", target: "incident/checkout-api", tier: 2 }),
      act("rejected_invalid_params", { id: "ACT-0004", order: 4, tier: 2 }),
    ],
    approvals: [], verification: null, metrics: null, postmortemReady: true, traceCount: 10,
  };
}

test("buildNotificationMessage takes the recommendations and their tiers from the stored actions", () => {
  const m = buildNotificationMessage({ kind: "analysis_ready", view: view(), blackboard: { origin }, publicUrl: "https://copilot.example.com/", now: new Date("2026-10-04T10:00:00Z") });
  assert.deepEqual(m.recommendations.map((r) => [r.order, r.actionType, r.tier, r.status]), [
    [1, "rollback_deployment", 3, "recommended"], [2, "add_incident_note", 2, "recommended"], [3, "run_arbitrary_command", 4, "blocked_forbidden"],
  ]);
  assert.deepEqual(m.source, { connectorId: "prom", type: "alertmanager", url: "https://prom.example.com/x" });
  assert.equal(m.links.incident, "https://copilot.example.com/incidents/INC-0001");
  assert.deepEqual(m.diagnosis, { category: "bad_deploy", confidence: "high", hypothesis: "bad deploy" });
  assert.equal(m.sentAt, "2026-10-04T10:00:00.000Z");
  assert.equal(buildNotificationMessage({ kind: "incident_opened", view: view(), blackboard: { origin }, publicUrl: null, now: new Date() }).links.incident, null);
});

function recorder(outcomes: NotifyOutcome[] = []): { notifier: Notifier; sent: NotificationMessage[] } {
  const sent: NotificationMessage[] = [];
  return { sent, notifier: { id: "n", type: "rec", send: async (m) => { sent.push(m); return outcomes.shift() ?? { ok: true }; } } };
}
const read = { view: () => view(), blackboard: () => ({ origin }) };

test("only subscribed notifiers receive the kind; the message is redacted", async () => {
  const a = recorder();
  const b = recorder();
  const lines: string[] = [];
  const svc = createNotificationService({
    notifiers: [{ notifier: a.notifier, events: ["analysis_ready"] }, { notifier: b.notifier, events: ["incident_resolved"] }],
    logger: createLogger({ level: "debug", secrets: [SECRET], write: (l) => void lines.push(l) }), secrets: [SECRET], publicUrl: null,
  });
  await svc.notify("analysis_ready", "INC-0001", read);
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 0);
  assert.ok(!JSON.stringify(a.sent).includes(SECRET));
  assert.match(a.sent[0]!.title, /\[REDACTED\]/);
  assert.ok(lines.some((l) => l.includes("notification_sent")));
});

test("one retry on a retryable outcome with a capped wait; a permanent failure is logged; nothing throws", async () => {
  const waits: number[] = [];
  const flaky = recorder([{ ok: false, retryable: true, retryAfterSec: 60, reason: "rate limited" }, { ok: true }]);
  const broken = recorder([{ ok: false, retryable: true, retryAfterSec: null, reason: "unavailable" }, { ok: false, retryable: true, retryAfterSec: null, reason: "unavailable" }]);
  const throwing: Notifier = { id: "t", type: "x", send: async () => { throw new ConnectorError("unavailable"); } };
  const lines: string[] = [];
  const svc = createNotificationService({
    notifiers: [{ notifier: flaky.notifier, events: ["run_failed"] }, { notifier: broken.notifier, events: ["run_failed"] }, { notifier: throwing, events: ["run_failed"] }],
    logger: createLogger({ level: "debug", secrets: [], write: (l) => void lines.push(l) }), secrets: [], publicUrl: null,
    sleep: async (ms) => void waits.push(ms),
  });
  await svc.notify("run_failed", "INC-0001", read);
  assert.equal(flaky.sent.length, 2);
  assert.equal(broken.sent.length, 2, "only one retry");
  assert.deepEqual(waits, [10_000, 1000]);
  assert.equal(lines.filter((l) => l.includes("notification_failed")).length, 2);
  await svc.notify("run_failed", "INC-404", { view: () => { throw new Error("not found"); }, blackboard: () => ({ origin }) });
});

test("the context resolver keeps the scenario call and refuses a live incident without configuration", () => {
  const calls: unknown[] = [];
  const scenarios = { get: (id: string, o?: { offsetSec?: number }) => { calls.push([id, o]); return { id } as never; } };
  const r = createIncidentContextResolver({ scenarios, live: null });
  assert.deepEqual(r.resolve({ scenarioId: "deploy-5xx-rollback", timeOffsetSec: 42 }), { kind: "scenario", scenario: { id: "deploy-5xx-rollback" } });
  assert.deepEqual(calls, [["deploy-5xx-rollback", { offsetSec: 42 }]]);
  assert.throws(() => r.resolve({ scenarioId: "live:prom", timeOffsetSec: 0, origin }), /live incident without connector configuration/);
  const live = createIncidentContextResolver({ scenarios, live: { sources: () => [], services: [{ name: "checkout-api", aliases: {} }] } });
  const ctx = live.resolve({ scenarioId: "live:prom", timeOffsetSec: 0, origin, alert: { title: "t", service: "checkout-api", account: null, signal: "other", threshold: null, rule: "r", detectedAt: "2026-10-04T09:41:30.000Z", severity: "sev1" } });
  assert.ok(ctx.kind === "live" && ctx.incidentService === "checkout-api" && ctx.origin.connectorId === "prom");
});

// Proves the notifier kit before the real notifiers use it.
const HOOK = "https://hooks.example.com/services/" + "h".repeat(24);
const echo = defineNotifier({
  type: "echo-webhook",
  configSchema: (h) => z.strictObject({ url: h.secret() }),
  create: (c, d) => ({
    id: d.id, type: "echo-webhook",
    async send(m, io) {
      try {
        await d.http.json({ method: "POST", url: c.url, body: JSON.stringify({ text: m.title }), headers: { "content-type": "application/json" }, signal: io.signal });
        return { ok: true };
      } catch (e) {
        const kind = e instanceof ConnectorError ? e.kind : "unavailable";
        return { ok: false, retryable: kind === "rate_limited" || kind === "unavailable" || kind === "timeout", retryAfterSec: e instanceof ConnectorError ? e.retryAfterSec : null, reason: kind };
      }
    },
  }),
});
describeNotifierConformance(echo, {
  env: { ECHO_URL: HOOK },
  entry: { url: "${ECHO_URL}", events: ["analysis_ready"] },
  secrets: [HOOK],
  okRoutes: [{ method: "POST", url: HOOK, body: { ok: true } }],
  failureRoutes: (kind) => [{ method: "POST", url: HOOK, status: kind === "retryable" ? 503 : 400 }],
});

// ---------- code-fix notifications (spec 009, AC-83 and AC-79) ----------

const FIX_TEST_NAME = "summarize returns zero for a cart without totals";
const run = (o: Partial<TestRunSummary> = {}): TestRunSummary => ({
  outcome: "passed", exitCode: 0, total: 4, passed: 4, failed: 0, skipped: 0, todo: 0, cancelled: 0, durationMs: 12, failures: [], ...o,
});
const redRun = (): TestRunSummary => run({
  outcome: "failed", exitCode: 1, total: 1, passed: 0, failed: 1,
  failures: [{ name: FIX_TEST_NAME, file: "tests/checkout/cart-summary.regression.test.ts", errorName: "TypeError", message: "x", frames: [] }],
});

function sampleAttempt(over: Partial<CodeFixAttempt> = {}): CodeFixAttempt {
  return {
    id: "fix_0123456789abcdef", incidentId: "INC-0001", repo: "acme/checkout-web", service: "checkout-web", connectorId: "sentry", errorGroupId: "4815162342",
    mode: "draft_pr", isolation: "isolated", status: "awaiting_approval", stage: "finalize", reason: null, violations: [],
    release: "checkout-web@2026.10.04-1", commitSha: "a".repeat(40), baseBranch: "main", baseCommitSha: "b".repeat(40),
    exception: { type: "TypeError", value: "Cannot read properties of undefined (reading 'total')" },
    anchor: { file: "src/checkout/cart-summary.ts", line: 12, column: 20, function: "summarize", inApp: true },
    files: [
      { path: "src/checkout/cart-summary.ts", role: "source", added: 1, removed: 1, afterSha256: "c".repeat(64) },
      { path: "tests/checkout/cart-summary.regression.test.ts", role: "test", added: 9, removed: 0, afterSha256: "d".repeat(64) },
    ],
    patch: "diff --git a/x b/x\n", patchSha256: "e".repeat(64), contents: [{ path: "src/checkout/cart-summary.ts", text: "post-image" }],
    evidence: { baseline: run({ total: 3, passed: 3 }), reproBefore: [redRun(), redRun()], fixAfter: [run({ total: 1, passed: 1 }), run({ total: 1, passed: 1 })], suiteAfter: run() },
    review: { verdict: "approve", concerns: [] }, suggestion: null, approvalId: "APR-0007", commit: null, pullRequest: null,
    llm: { calls: 3, promptTokens: 10, completionTokens: 10 },
    startedAt: "2026-10-04T10:00:00.000Z", patchReadyAt: "2026-10-04T10:04:00.000Z", finishedAt: null, version: 2, ...over,
  };
}
const sampleApproval = { id: "APR-0007", expiresAt: "2026-10-07T10:04:00.000Z" };

test("buildCodeFixNotificationMessage adds the code-fix facts and keeps the incident fields", () => {
  const now = new Date("2026-10-04T10:05:00Z");
  const m = buildCodeFixNotificationMessage({
    kind: "code_fix_ready", view: view(), blackboard: { origin }, publicUrl: "https://copilot.example.com/", now, attempt: sampleAttempt(), approval: sampleApproval,
  });
  const plain = buildNotificationMessage({ kind: "code_fix_ready", view: view(), blackboard: { origin }, publicUrl: "https://copilot.example.com/", now });
  const { codeFix, ...rest } = m;
  assert.deepEqual(rest, plain);
  assert.deepEqual(codeFix, {
    attemptId: "fix_0123456789abcdef", status: "awaiting_approval", mode: "draft_pr", repo: "acme/checkout-web", baseBranch: "main",
    location: { file: "src/checkout/cart-summary.ts", line: 12 }, exceptionType: "TypeError",
    diff: { added: 10, removed: 1, files: 2 }, testName: FIX_TEST_NAME,
    evidence: { failedBefore: true, passesAfter: true, suiteTotal: 4, suiteFailed: 0 },
    approval: { id: "APR-0007", expiresAt: "2026-10-07T10:04:00.000Z" }, pullRequest: null,
    links: { approval: "https://copilot.example.com/approvals?status=pending", pullRequest: null },
  });
  assert.ok(!JSON.stringify(m).includes("post-image"), "post-images never leave");
  assert.ok(!JSON.stringify(m).includes("diff --git"), "the patch text is not in the message");
  // A flaky reproduction or a red suite is reported as such; a missing anchor or public URL gives nulls.
  const weak = buildCodeFixNotificationMessage({
    kind: "code_fix_pr_opened", view: view(), blackboard: { origin }, publicUrl: null, now,
    attempt: sampleAttempt({
      status: "pr_opened", anchor: null, exception: null, approvalId: null,
      evidence: { baseline: null, reproBefore: [redRun(), run()], fixAfter: [run()], suiteAfter: run({ outcome: "failed", failed: 1, passed: 3 }) },
      pullRequest: { number: 42, url: "https://github.com/acme/checkout-web/pull/42", branch: "incident-copilot/fix-fix_0123456789abcdef" },
    }),
    approval: null,
  }).codeFix!;
  assert.deepEqual([weak.location, weak.exceptionType, weak.approval, weak.links.approval], [null, null, null, null]);
  assert.deepEqual(weak.evidence, { failedBefore: false, passesAfter: false, suiteTotal: 4, suiteFailed: 1 });
  assert.deepEqual(weak.pullRequest, { number: 42, url: "https://github.com/acme/checkout-web/pull/42" });
  assert.equal(weak.links.pullRequest, "https://github.com/acme/checkout-web/pull/42");
});

test("a code-fix message goes only to notifiers listing its kind, redacted; a failure is logged and the attempt is untouched", async () => {
  const opted = recorder();
  const defaults = recorder();
  const prOnly = recorder();
  const throwing: Notifier = { id: "t", type: "x", send: async () => { throw new Error("boom"); } };
  const lines: string[] = [];
  const svc = createNotificationService({
    notifiers: [
      { notifier: opted.notifier, events: ["code_fix_ready", "code_fix_pr_opened"] },
      { notifier: defaults.notifier, events: [...DEFAULT_NOTIFICATION_EVENTS] },
      { notifier: prOnly.notifier, events: ["code_fix_pr_opened"] },
      { notifier: throwing, events: ["code_fix_ready"] },
    ],
    logger: createLogger({ level: "debug", secrets: [SECRET], write: (l) => void lines.push(l) }), secrets: [SECRET], publicUrl: "https://copilot.example.com",
  });
  const attempt = sampleAttempt({ exception: { type: `TypeError ${SECRET}`, value: SECRET } });
  attempt.evidence.reproBefore[0]!.failures[0]!.name = `leaks ${SECRET}`;
  const before = structuredClone(attempt);
  await svc.notifyCodeFix("code_fix_ready", { attempt, approval: sampleApproval }, read);
  assert.equal(opted.sent.length, 1);
  assert.equal(defaults.sent.length, 0, "the default events never include a code-fix kind");
  assert.equal(prOnly.sent.length, 0);
  const m = opted.sent[0]!;
  assert.equal(m.kind, "code_fix_ready");
  assert.ok(!JSON.stringify(opted.sent).includes(SECRET));
  assert.match(m.codeFix!.testName!, /\[REDACTED\]/);
  assert.match(m.title, /\[REDACTED\]/);
  assert.deepEqual(attempt, before, "notifying never changes the attempt");
  assert.ok(lines.some((l) => l.includes("notification_sent") && l.includes("code_fix_ready")));
  assert.ok(lines.some((l) => l.includes("notification_failed") && l.includes("notifier threw")));
  // A read model that throws is logged, never thrown.
  await svc.notifyCodeFix("code_fix_pr_opened", { attempt, approval: null }, { view: () => { throw new Error("gone"); }, blackboard: () => ({ origin }) });
  assert.equal(prOnly.sent.length, 0);
  assert.ok(lines.some((l) => l.includes("notification_failed") && l.includes("code_fix_pr_opened")));
});

// The container wiring: the fixer notifies through a never-throwing callback; an opened pull request sends code_fix_pr_opened.
describe("code-fix notification wiring", () => {
  const GH_TOKEN = "ghp_" + "N5".repeat(18);
  function fakeSentry(): ConnectorDefinition<unknown> {
    return defineConnector({
      type: "sentry", displayName: "Fake Sentry (tests)", capabilities: ["query"], configSchema: () => z.strictObject({}),
      create: (_c, d) => ({ id: d.id, type: "sentry", ingest: null, query: { metricNames: [] } }),
    });
  }
  function setup(script: NotifyOutcome[] = []) {
    const fake = createFakeNotifier();
    fake.script.push(...script);
    const codeFix: CodeFixConfig = {
      enabled: true, mode: "draft_pr", approvalTtlHours: 72, sandbox: { network: "isolated" },
      github: { apiUrl: "https://api.github.com", token: GH_TOKEN },
      commitAuthor: { name: "incident-copilot", email: "incident-copilot@example.invalid" },
      limits: { ...CODE_FIX_DEFAULT_LIMITS }, fixableExceptionTypes: ["TypeError"], repositories: [{ ...SAMPLE_REPO }],
    };
    const copilot: CopilotConfig = {
      version: 1, mode: "shadow", publicUrl: "https://copilot.example.com", ingest: { ...DEFAULT_INGEST },
      services: [{ name: "checkout-web", aliases: {} }],
      connectors: [{ id: "sentry", type: "sentry", enabled: true, severityMap: null, capabilities: ["query"], config: {} }],
      notifiers: [
        { id: "fixes", type: FAKE_NOTIFIER_TYPE, events: ["code_fix_ready", "code_fix_pr_opened"], config: {} },
        { id: "team", type: FAKE_NOTIFIER_TYPE, events: [...DEFAULT_NOTIFICATION_EVENTS], config: {} },
      ],
      codeFix, secrets: [GH_TOKEN],
    };
    let c: TestContainer | null = null;
    c = createTestContainer({
      copilot, connectorDefinitions: [fakeSentry()], notifierDefinitions: [fake.definition], sleep: async () => {},
      codeFixPorts: {
        workspace: new FakeGitWorkspace(new Error("no git in this test")), reader: new FakeCodeHostReader(),
        sandbox: () => new FakeSandboxRunner([]), selfTest: async () => ({ ok: true }),
        publish: async (id: string) => {
          const fixes = c!.codeFix!.store;
          const a = fixes.getAttempt(id)!;
          fixes.updateAttempt(id, {
            ...a, status: "pr_opened", stage: "publish",
            pullRequest: { number: 42, url: "https://github.com/acme/checkout-web/pull/42", branch: `incident-copilot/fix-${id}` },
            finishedAt: c!.clock.now().toISOString(),
          }, a.version);
        },
      },
    });
    const incidentId = initialBlackboard(c, "deploy-5xx-rollback").incidentId;
    const fixes = c.codeFix!.store;
    const now = c.clock.now();
    const approvalId = c.ids.approval();
    const requestedAt = new Date(now.getTime() - 3_600_000).toISOString();
    const attempt = sampleAttempt({ incidentId, approvalId, repo: SAMPLE_REPO.repo, startedAt: requestedAt, patchReadyAt: requestedAt, version: 0 });
    const approval: Approval = {
      id: approvalId, incidentId, actionId: attempt.id, status: "pending", requestedAt, expiresAt: new Date(Date.parse(requestedAt) + 72 * 3_600_000).toISOString(),
      decidedAt: null, approver: null, comment: null, decisionSource: null, version: 0, subject: "code_fix", patchSha256: attempt.patchSha256!,
    };
    fixes.transaction(() => {
      fixes.insertAttempt(attempt, { keyHeld: true });
      fixes.insertApproval(approval);
    });
    return { c, fake, attemptId: attempt.id, approvalId };
  }

  test("an approved fix whose pull request opens notifies code_fix_pr_opened to the opted-in notifier only", async () => {
    const { c, fake, attemptId, approvalId } = setup();
    try {
      await c.approvals.decide(approvalId, { decision: "approve", approver: "ana" } as never, TEST_APPROVAL_TOKEN, { requestId: "req-1" });
      await c.codeFix!.idle();
      assert.deepEqual(fake.messages.map((m) => m.kind), ["code_fix_pr_opened"]);
      const m = fake.messages[0]!;
      assert.equal(m.codeFix!.attemptId, attemptId);
      assert.equal(m.codeFix!.status, "pr_opened");
      assert.equal(m.codeFix!.links.pullRequest, "https://github.com/acme/checkout-web/pull/42");
      assert.ok(m.links.incident?.startsWith("https://copilot.example.com/incidents/"));
      assert.ok(!JSON.stringify(fake.messages).includes(GH_TOKEN));
    } finally {
      c.close();
    }
  });

  test("a failing notifier is logged and never changes the attempt", async () => {
    const { c, fake, attemptId, approvalId } = setup([{ ok: false, retryable: false, retryAfterSec: null, reason: "gone" }]);
    try {
      await c.approvals.decide(approvalId, { decision: "approve", approver: "ana" } as never, TEST_APPROVAL_TOKEN, { requestId: "req-1" });
      await c.codeFix!.idle();
      assert.equal(fake.messages.length, 1);
      const a = c.codeFix!.store.getAttempt(attemptId)!;
      assert.equal(a.status, "pr_opened");
      assert.ok(c.logs.some((l) => l.includes("notification_failed") && l.includes("code_fix_pr_opened")));
    } finally {
      c.close();
    }
  });
});
