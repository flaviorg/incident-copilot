// Code-fix approvals through ApprovalService (spec 009, decisions 14 and 19; AC-75, AC-76). The real container in
// draft_pr mode, with the fixer's ports replaced by in-memory fakes and the publish hook recorded; the attempt and its
// approval are written straight into the store, as the fixer leaves them at awaiting_approval.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import type { Approval, CodeFixAttempt } from "../../src/contracts/index.ts";
import { defineConnector } from "../../src/connectors/types.ts";
import type { ConnectorDefinition } from "../../src/connectors/types.ts";
import type { CopilotConfig, CodeFixConfig } from "../../src/infra/copilot-config/schema.ts";
import { DEFAULT_INGEST } from "../../src/infra/copilot-config/schema.ts";
import { CODE_FIX_DEFAULT_LIMITS } from "../../src/domain/code-fix/limits.ts";
import { canonicalPatchPayload } from "../../src/domain/code-fix/patch-payload.ts";
import { ApprovalsDisabledError, AuthError, ConflictError, LockedError, UnprocessableError, ValidationError } from "../../src/domain/errors.ts";
import { sha256Hex } from "../../src/app/code-fix-service.ts";
import {
  ANCHOR_PATH, FakeCodeHostReader, FakeGitWorkspace, FakeSandboxRunner, SAMPLE_REPO, SHA_HEAD, SHA_RELEASE,
} from "../helpers/code-fix-fakes.ts";
import { createTestContainer, initialBlackboard, TEST_APPROVAL_TOKEN } from "../helpers/container.ts";
import { createFakeFetch } from "../helpers/fake-fetch.ts";
import type { FakeRoute } from "../helpers/fake-fetch.ts";
import type { TestContainer } from "../helpers/container.ts";

const SECRET = "ghp_" + "K3".repeat(18);
const TEST_PATH = "tests/checkout/cart-summary.regression.test.ts";
const SCENARIO = "deploy-5xx-rollback";

function fakeSentry(): ConnectorDefinition<unknown> {
  return defineConnector({
    type: "sentry",
    displayName: "Fake Sentry (tests)",
    capabilities: ["query"],
    configSchema: () => z.strictObject({}),
    create: (_c, d) => ({ id: d.id, type: "sentry", ingest: null, query: { metricNames: [] } }),
  });
}

function codeFixConfig(over: Partial<CodeFixConfig> = {}): CodeFixConfig {
  return {
    enabled: true,
    mode: "draft_pr",
    approvalTtlHours: 72,
    sandbox: { network: "isolated" },
    github: { apiUrl: "https://api.github.com", token: SECRET },
    commitAuthor: { name: "incident-copilot", email: "incident-copilot@example.invalid" },
    limits: { ...CODE_FIX_DEFAULT_LIMITS },
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

type Setup = { c: TestContainer; published: string[] };

function setup(o: { approvalToken?: string | null; fetch?: typeof fetch } = {}): Setup {
  const published: string[] = [];
  const c = createTestContainer({
    ...(o.approvalToken !== undefined ? { approvalToken: o.approvalToken } : {}),
    copilot: copilotWith(codeFixConfig()),
    connectorDefinitions: [fakeSentry()],
    ...(o.fetch ? { fetch: o.fetch } : {}),
    // With a fetch, the real GitHub reader, writer and publisher are built over it.
    codeFixPorts: o.fetch
      ? { workspace: new FakeGitWorkspace(new Error("no git in this test")), sandbox: () => new FakeSandboxRunner([]), selfTest: async () => ({ ok: true }) }
      : {
        workspace: new FakeGitWorkspace(new Error("no git in this test")),
        reader: new FakeCodeHostReader(),
        sandbox: () => new FakeSandboxRunner([]),
        selfTest: async () => ({ ok: true }),
        publish: async (id: string) => void published.push(id),
      },
  });
  return { c, published };
}

function artifact() {
  const source = "export const summarize = (cart) => ({ total: cart.totals?.total ?? 0 });\n";
  const testText = 'import { test } from "node:test";\n';
  const contents = [{ path: ANCHOR_PATH, text: source }, { path: TEST_PATH, text: testText }];
  const files = [
    { path: ANCHOR_PATH, role: "source" as const, added: 1, removed: 1, afterSha256: sha256Hex(source) },
    { path: TEST_PATH, role: "test" as const, added: 1, removed: 0, afterSha256: sha256Hex(testText) },
  ];
  const patch = `diff --git a/${ANCHOR_PATH} b/${ANCHOR_PATH}\n`;
  return { contents, files, patch, patchSha256: sha256Hex(canonicalPatchPayload(patch, files)) };
}

/** An attempt at awaiting_approval with its pending code-fix approval, as finishPatchReady writes them. */
function awaiting(c: TestContainer, o: { incidentId?: string; expired?: boolean; attemptId?: string } = {}): { attempt: CodeFixAttempt; approval: Approval } {
  const incidentId = o.incidentId ?? initialBlackboard(c, SCENARIO).incidentId;
  const fixes = c.codeFix!.store;
  const now = c.clock.now();
  const art = artifact();
  const attemptId = o.attemptId ?? "fix_0123456789abcdef";
  const requestedAt = new Date(now.getTime() - (o.expired ? 80 : 1) * 3_600_000).toISOString();
  const expiresAt = new Date(Date.parse(requestedAt) + 72 * 3_600_000).toISOString();
  const approvalId = c.ids.approval();
  const base: CodeFixAttempt = {
    id: attemptId, incidentId, repo: SAMPLE_REPO.repo, service: SAMPLE_REPO.service, connectorId: "sentry", errorGroupId: "4815162342",
    mode: "draft_pr", isolation: "isolated", status: "awaiting_approval", stage: "finalize", reason: null, violations: [],
    release: "checkout-web@2026.10.04-1", commitSha: SHA_RELEASE, baseBranch: "main", baseCommitSha: SHA_HEAD,
    exception: { type: "TypeError", value: "Cannot read properties of undefined (reading 'total')" }, anchor: null,
    files: art.files, patch: art.patch, patchSha256: art.patchSha256, contents: art.contents,
    evidence: { baseline: null, reproBefore: [], fixAfter: [], suiteAfter: null }, review: { verdict: "approve", concerns: [] },
    suggestion: null, approvalId, commit: null, pullRequest: null, llm: { calls: 3, promptTokens: 10, completionTokens: 10 },
    startedAt: requestedAt, patchReadyAt: requestedAt, finishedAt: null, version: 0,
  };
  const approval: Approval = {
    id: approvalId, incidentId, actionId: attemptId, status: "pending", requestedAt, expiresAt, decidedAt: null, approver: null,
    comment: null, decisionSource: null, version: 0, subject: "code_fix", patchSha256: art.patchSha256,
  };
  fixes.transaction(() => {
    fixes.insertAttempt(base, { keyHeld: true });
    fixes.insertApproval(approval);
  });
  return { attempt: fixes.getAttempt(attemptId)!, approval: fixes.getApproval(approvalId)! };
}

const decide = (c: TestContainer, id: string, body: Record<string, unknown>, token: string | undefined = TEST_APPROVAL_TOKEN) =>
  c.approvals.decide(id, body as never, token, { requestId: "req-1" });

/** Spies on the incident's decision, expiry and resume paths; each must stay at zero calls. */
function spyIncidentPaths(c: TestContainer): Record<string, number> {
  const calls: Record<string, number> = { applyDecision: 0, expireDueApprovals: 0, resume: 0 };
  const inc = c.incidents as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of Object.keys(calls)) {
    const orig = inc[name]!.bind(c.incidents);
    inc[name] = (...a: unknown[]) => {
      calls[name] = (calls[name] ?? 0) + 1;
      return orig(...a);
    };
  }
  return calls;
}

const conflict = (code: string) => (e: unknown) => e instanceof ConflictError && e.code === code;

// =====================================================================================================================

describe("check order is unchanged for code-fix approval ids (AC-76)", () => {
  test("missing body, approvals disabled, lockout, wrong token and ambiguous text", async () => {
    const { c } = setup();
    const { approval, attempt } = awaiting(c);
    await assert.rejects(decide(c, approval.id, {}), ValidationError);

    const off = setup({ approvalToken: null });
    const offPair = awaiting(off.c);
    await assert.rejects(decide(off.c, offPair.approval.id, { decision: "approve", approver: "ana" }), ApprovalsDisabledError);

    await assert.rejects(decide(c, approval.id, { decision: "approve", approver: "ana" }, "wrong-token-000000"), AuthError);
    const fail = c.store.listAudit(attempt.incidentId).find((e) => e.event === "approval_auth_failed");
    assert.ok(fail, "the auth failure is audited on the incident found in code_fix_approvals");
    assert.equal(fail.details.approvalId, approval.id);
    assert.ok(!JSON.stringify(fail).includes("wrong-token-000000"));

    await assert.rejects(decide(c, approval.id, { text: "sim, mas espera", approver: "ana" }), (e) => e instanceof UnprocessableError && e.code === "ambiguous_decision");
    for (let i = 0; i < 4; i++) await decide(c, approval.id, { decision: "approve", approver: "ana" }, "x".repeat(20)).catch(() => {});
    await assert.rejects(decide(c, approval.id, { decision: "approve", approver: "ana" }), LockedError);
    assert.equal(c.codeFix!.store.getApproval(approval.id)!.status, "pending");
    assert.equal(c.codeFix!.store.getAttempt(attempt.id)!.status, "awaiting_approval");
  });
});

describe("expiry branches before the incident's paths (AC-76)", () => {
  test("an expired code-fix approval materializes approval and attempt expired, audits approval_expired and answers 409", async () => {
    const { c, published } = setup();
    const { approval, attempt } = awaiting(c, { expired: true });
    const versionBefore = c.store.loadBlackboard(attempt.incidentId).version;
    const spies = spyIncidentPaths(c);
    await assert.rejects(decide(c, approval.id, { decision: "approve", approver: "ana" }), conflict("approval_expired"));
    const ap = c.codeFix!.store.getApproval(approval.id)!;
    assert.deepEqual([ap.status, ap.decisionSource], ["expired", "expiry"]);
    const at = c.codeFix!.store.getAttempt(attempt.id)!;
    assert.equal(at.status, "expired");
    assert.ok(at.finishedAt);
    const exp = c.store.listAudit(attempt.incidentId).filter((e) => e.event === "approval_expired");
    assert.equal(exp.length, 1);
    assert.equal(exp[0]!.tier, 3);
    assert.equal(exp[0]!.actor, "system:approval-service");
    assert.equal(exp[0]!.details.subject, "code_fix");
    assert.equal(exp[0]!.details.attemptId, attempt.id);
    assert.deepEqual(spies, { applyDecision: 0, expireDueApprovals: 0, resume: 0 });
    assert.equal(c.store.loadBlackboard(attempt.incidentId).version, versionBefore);
    await c.codeFix!.idle();
    assert.deepEqual(published, []);
    // Already materialized: a second decision is not pending.
    await assert.rejects(decide(c, approval.id, { decision: "approve", approver: "ana" }), conflict("approval_not_pending"));
  });
});

describe("decisions (AC-76)", () => {
  test("approve moves both to approved in one transaction, audits approval_approved and enqueues the publish", async () => {
    const { c, published } = setup();
    const { approval, attempt } = awaiting(c);
    const versionBefore = c.store.loadBlackboard(attempt.incidentId).version;
    const incidentBefore = c.incidents.get(attempt.incidentId);
    const spies = spyIncidentPaths(c);
    const r = await decide(c, approval.id, { decision: "approve", approver: "ana", comment: `ship it ${SECRET}` });
    assert.equal(r.approval.status, "approved");
    assert.equal(r.approval.subject, "code_fix");
    assert.equal(r.approval.patchSha256, approval.patchSha256);
    assert.equal(r.incident.incident.id, attempt.incidentId);
    assert.deepEqual(r.incident, incidentBefore);
    assert.equal(c.codeFix!.store.getApproval(approval.id)!.status, "approved");
    const at = c.codeFix!.store.getAttempt(attempt.id)!;
    assert.equal(at.status, "approved");
    assert.equal(at.finishedAt, null);
    assert.equal(c.codeFix!.store.holdsKey(at.repo, at.errorGroupId), true);
    const audit = c.store.listAudit(attempt.incidentId).filter((e) => e.event === "approval_approved");
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.actor, "human:ana");
    assert.equal(audit[0]!.tier, 3);
    assert.equal(audit[0]!.details.subject, "code_fix");
    assert.equal(audit[0]!.details.approvalId, approval.id);
    assert.equal(audit[0]!.details.attemptId, attempt.id);
    assert.equal(audit[0]!.details.source, "structured");
    assert.ok(!JSON.stringify(audit).includes(SECRET));
    assert.ok(!JSON.stringify(c.codeFix!.store.getApproval(approval.id)).includes(SECRET));
    await c.codeFix!.idle();
    assert.deepEqual(published, [attempt.id]);
    assert.deepEqual(spies, { applyDecision: 0, expireDueApprovals: 0, resume: 0 });
    assert.equal(c.store.loadBlackboard(attempt.incidentId).version, versionBefore);
  });

  test("reject moves both to rejected, with no publish; the key stays held", async () => {
    const { c, published } = setup();
    const { approval, attempt } = awaiting(c);
    const r = await decide(c, approval.id, { text: "no", approver: "bia" });
    assert.deepEqual([r.approval.status, r.approval.decisionSource], ["rejected", "text"]);
    const at = c.codeFix!.store.getAttempt(attempt.id)!;
    assert.equal(at.status, "rejected");
    assert.ok(at.finishedAt);
    assert.equal(c.codeFix!.store.holdsKey(at.repo, at.errorGroupId), true);
    const audit = c.store.listAudit(attempt.incidentId).filter((e) => e.event === "approval_rejected");
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.actor, "human:bia");
    await c.codeFix!.idle();
    assert.deepEqual(published, []);
  });

  test("a failing audit write rolls back the approval and the attempt (one transaction)", async () => {
    const { c, published } = setup();
    const { approval, attempt } = awaiting(c);
    const orig = c.store.appendAudit.bind(c.store);
    c.store.appendAudit = (e) => {
      if (e.event === "approval_approved") throw new Error("disk full");
      return orig(e);
    };
    await assert.rejects(decide(c, approval.id, { decision: "approve", approver: "ana" }), /disk full/);
    c.store.appendAudit = orig;
    assert.equal(c.codeFix!.store.getApproval(approval.id)!.status, "pending");
    assert.equal(c.codeFix!.store.getAttempt(attempt.id)!.status, "awaiting_approval");
    await c.codeFix!.idle();
    assert.deepEqual(published, []);
  });

  test("deciding twice gives 409 approval_not_pending", async () => {
    const { c } = setup();
    const { approval } = awaiting(c);
    await decide(c, approval.id, { decision: "approve", approver: "ana" });
    await assert.rejects(decide(c, approval.id, { decision: "reject", approver: "bia" }), conflict("approval_not_pending"));
  });

  test("an attempt that is not awaiting_approval gives 409 code_fix_not_awaiting_approval", async () => {
    const { c, published } = setup();
    const { approval, attempt } = awaiting(c);
    const fixes = c.codeFix!.store;
    fixes.updateAttempt(attempt.id, { ...attempt, status: "gave_up", reason: "interrupted", finishedAt: c.clock.now().toISOString() }, attempt.version);
    await assert.rejects(decide(c, approval.id, { decision: "approve", approver: "ana" }), conflict("code_fix_not_awaiting_approval"));
    assert.equal(fixes.getApproval(approval.id)!.status, "pending");
    await c.codeFix!.idle();
    assert.deepEqual(published, []);
  });

  test("an incident in status resolved still accepts the decision", async () => {
    const { c, published } = setup();
    const { approval, attempt } = awaiting(c);
    c.store.updateIncidentStatus(attempt.incidentId, "resolved", {});
    const r = await decide(c, approval.id, { decision: "approve", approver: "ana" });
    assert.equal(r.approval.status, "approved");
    assert.equal(r.incident.incident.status, "resolved");
    await c.codeFix!.idle();
    assert.deepEqual(published, [attempt.id]);
  });
});

describe("list merges both tables (AC-75)", () => {
  test("code-fix items carry subject and patchSha256; action approvals keep their exact shape", async () => {
    const { c } = setup();
    const v = await c.incidents.open({ scenarioId: SCENARIO }, { requestId: null });
    const actionPending = c.approvals.list("pending");
    assert.ok(actionPending.length > 0, "the scenario leaves an action approval pending");
    for (const a of actionPending) {
      assert.equal("subject" in a, false);
      assert.equal("patchSha256" in a, false);
    }
    const before = JSON.stringify(actionPending);
    const { approval } = awaiting(c, { incidentId: v.incident.id });
    const merged = c.approvals.list("pending");
    assert.equal(merged.length, actionPending.length + 1);
    assert.equal(JSON.stringify(merged.filter((a) => a.subject === undefined)), before);
    const fix = merged.find((a) => a.id === approval.id)!;
    assert.equal(fix.subject, "code_fix");
    assert.equal(fix.patchSha256, approval.patchSha256);
    assert.equal(fix.actionId, approval.actionId);
    // The incident's own views never see the code-fix approval.
    assert.ok(c.incidents.get(v.incident.id).approvals.every((a) => a.id !== approval.id));
  });

  test("an overdue code-fix approval lists as expired", () => {
    const { c } = setup();
    const { approval } = awaiting(c, { expired: true });
    assert.ok(c.approvals.list("pending").every((a) => a.id !== approval.id));
    assert.ok(c.approvals.list("expired").some((a) => a.id === approval.id && a.subject === "code_fix"));
  });
});

describe("container wiring of the publisher (decision 3)", () => {
  test("in draft_pr mode an approval reaches the real publisher, which opens a draft pull request over the injected fetch", async () => {
    const R = `https://api.github.com/repos/${SAMPLE_REPO.repo}`;
    const TREE = "f".repeat(40);
    const COMMIT = "1".repeat(40);
    const BRANCH = "incident-copilot/fix-fix_0123456789abcdef";
    const routes: FakeRoute[] = [
      { method: "GET", url: `${R}/branches/main`, body: { name: "main", protected: true, commit: { sha: SHA_HEAD } } },
      { method: "GET", url: `${R}/compare/${SHA_HEAD}...main`, body: { files: [] } },
      { method: "GET", url: new RegExp(`^${R.replace(/[.]/g, "\\.")}/pulls\\?`), body: [] },
      { method: "GET", url: `${R}/git/commits/${SHA_HEAD}`, body: { sha: SHA_HEAD, tree: { sha: "c".repeat(40) }, parents: [] } },
      { method: "POST", url: `${R}/git/blobs`, status: 201, body: { sha: "d".repeat(40) } },
      { method: "POST", url: `${R}/git/trees`, status: 201, body: { sha: TREE } },
      { method: "POST", url: `${R}/git/commits`, status: 201, body: { sha: COMMIT, tree: { sha: TREE }, parents: [{ sha: SHA_HEAD }] } },
      { method: "POST", url: `${R}/git/refs`, status: 201, body: { ref: `refs/heads/${BRANCH}`, object: { sha: COMMIT } } },
      { method: "POST", url: `${R}/pulls`, status: 201, body: { number: 11, html_url: "https://github.com/acme/checkout-web/pull/11", draft: true, head: { ref: BRANCH, sha: COMMIT } } },
    ];
    const gh = createFakeFetch(routes);
    const { c } = setup({ fetch: gh.fetch });
    const { approval, attempt } = awaiting(c);
    assert.equal(gh.calls.length, 0, "nothing reaches the code host before the approval");
    await decide(c, approval.id, { decision: "approve", approver: "ana" });
    await c.codeFix!.idle();
    const a = c.codeFix!.store.getAttempt(attempt.id)!;
    assert.equal(a.status, "pr_opened");
    assert.deepEqual(a.pullRequest, { number: 11, url: "https://github.com/acme/checkout-web/pull/11", branch: BRANCH });
    assert.deepEqual(a.commit, { sha: COMMIT, tree: TREE });
    assert.ok(gh.calls.every((x) => x.method === "GET" || x.method === "POST"));
    const pull = JSON.parse(gh.calls.find((x) => x.method === "POST" && x.url.endsWith("/pulls"))!.body!) as { draft: boolean };
    assert.equal(pull.draft, true);
    assert.ok(c.store.listAudit(attempt.incidentId).some((e) => e.event === "code_fix_pr_opened"));
  });
});
