// Code-fix surfaces over HTTP (spec 009, HTTP table and decision 21; AC-74, AC-79): GET /incidents/:id/code-fix, the
// postmortem's "Code fix" section and code-fix approvals in GET /approvals. The real container in shadow mode, with the
// fixer's ports replaced by in-memory fakes; attempts are written straight into the CodeFixStore.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import { CodeFixAttemptViewSchema } from "../../src/contracts/index.ts";
import type { Approval, CodeFixAttempt } from "../../src/contracts/index.ts";
import { defineConnector } from "../../src/connectors/types.ts";
import type { ConnectorDefinition } from "../../src/connectors/types.ts";
import type { CopilotConfig, CodeFixConfig } from "../../src/infra/copilot-config/schema.ts";
import { DEFAULT_INGEST } from "../../src/infra/copilot-config/schema.ts";
import { CODE_FIX_DEFAULT_LIMITS } from "../../src/domain/code-fix/limits.ts";
import { renderCodeFixSection } from "../../src/domain/report/code-fix-section.ts";
import { redactSecrets } from "../../src/infra/redact.ts";
import { toCodeFixView } from "../../src/app/views.ts";
import { sha256Hex } from "../../src/app/code-fix-service.ts";
import { buildServer } from "../../src/http/server.ts";
import { ANCHOR_PATH, FakeCodeHostReader, FakeGitWorkspace, FakeSandboxRunner, SAMPLE_REPO, SHA_HEAD, SHA_RELEASE } from "../helpers/code-fix-fakes.ts";
import { createTestContainer, TEST_APPROVAL_TOKEN } from "../helpers/container.ts";
import type { TestContainer } from "../helpers/container.ts";

// Built at run time so no key-shaped literal sits in the tree.
const SECRET = "ghp_" + "Z9".repeat(18);
const API_TOKEN = "api-" + "t".repeat(24);
const TEST_PATH = "tests/checkout/cart-summary.regression.test.ts";
type App = ReturnType<typeof buildServer>;
const get = (a: App, url: string, headers: Record<string, string> = {}) => a.inject({ method: "GET", url, headers });
const post = (a: App, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  a.inject({ method: "POST", url, payload: payload as object, headers });

function fakeSentry(): ConnectorDefinition<unknown> {
  return defineConnector({
    type: "sentry",
    displayName: "Fake Sentry (tests)",
    capabilities: ["query"],
    configSchema: () => z.strictObject({}),
    create: (_c, d) => ({ id: d.id, type: "sentry", ingest: null, query: { metricNames: [] } }),
  });
}

function codeFixConfig(): CodeFixConfig {
  return {
    enabled: true,
    mode: "shadow",
    approvalTtlHours: 72,
    sandbox: { network: "isolated" },
    github: { apiUrl: "https://api.github.com", token: null },
    commitAuthor: { name: "incident-copilot", email: "incident-copilot@example.invalid" },
    limits: { ...CODE_FIX_DEFAULT_LIMITS },
    fixableExceptionTypes: ["TypeError", "RangeError", "ReferenceError"],
    repositories: [{ ...SAMPLE_REPO }],
  } as CodeFixConfig;
}

function copilot(): CopilotConfig {
  return {
    version: 1, mode: "shadow", publicUrl: null, ingest: { ...DEFAULT_INGEST },
    services: [{ name: "checkout-web", aliases: {} }],
    connectors: [{ id: "sentry", type: "sentry", enabled: true, severityMap: null, capabilities: ["query"], config: {} }],
    notifiers: [], codeFix: codeFixConfig(), secrets: [SECRET],
  };
}

function setup(o: { env?: Record<string, string>; withCodeFix?: boolean } = {}): { c: TestContainer; a: App } {
  const withCodeFix = o.withCodeFix ?? true;
  const c = createTestContainer({
    ...(o.env ? { env: o.env } : {}),
    ...(withCodeFix
      ? {
        copilot: copilot(),
        connectorDefinitions: [fakeSentry()],
        codeFixPorts: {
          workspace: new FakeGitWorkspace(new Error("no git in this test")),
          reader: new FakeCodeHostReader(),
          sandbox: () => new FakeSandboxRunner([]),
          selfTest: async () => ({ ok: true }),
        },
      }
      : {}),
  });
  return { c, a: buildServer(c) };
}

/** A patch_ready attempt whose patch, exception and contents carry the planted secret. */
function attemptFor(incidentId: string, over: Partial<CodeFixAttempt> = {}): CodeFixAttempt {
  const source = `export const summarize = (cart) => ({ total: cart.totals?.total ?? 0, k: "${SECRET}" });\n`;
  const testText = 'import { test } from "node:test";\n';
  const patch = `diff --git a/${ANCHOR_PATH} b/${ANCHOR_PATH}\n+// ${SECRET}\n`;
  const now = "2026-10-04T10:00:00.000Z";
  return {
    id: "fix_0123456789abcdef", incidentId, repo: SAMPLE_REPO.repo, service: SAMPLE_REPO.service, connectorId: "sentry", errorGroupId: "4815162342",
    mode: "shadow", isolation: "isolated", status: "patch_ready", stage: "finalize", reason: null, violations: [],
    release: "checkout-web@2026.10.04-1", commitSha: SHA_RELEASE, baseBranch: "main", baseCommitSha: SHA_HEAD,
    exception: { type: "TypeError", value: `Cannot read properties of undefined (token ${SECRET})` }, anchor: null,
    files: [
      { path: ANCHOR_PATH, role: "source", added: 1, removed: 1, afterSha256: sha256Hex(source) },
      { path: TEST_PATH, role: "test", added: 1, removed: 0, afterSha256: sha256Hex(testText) },
    ],
    patch, patchSha256: sha256Hex(patch), contents: [{ path: ANCHOR_PATH, text: source }, { path: TEST_PATH, text: testText }],
    evidence: { baseline: null, reproBefore: [], fixAfter: [], suiteAfter: null }, review: { verdict: "approve", concerns: [] },
    suggestion: null, approvalId: null, commit: null, pullRequest: null, llm: { calls: 3, promptTokens: 10, completionTokens: 10 },
    startedAt: now, patchReadyAt: now, finishedAt: now, version: 0,
    ...over,
  };
}

function insert(c: TestContainer, a: CodeFixAttempt, approval?: Approval, keyHeld = true): void {
  const fixes = c.codeFix!.store;
  fixes.transaction(() => {
    fixes.insertAttempt(a, { keyHeld });
    if (approval) fixes.insertApproval(approval);
  });
}

/** Opens the scenario incident and approves it, so it ends resolved with a post-mortem. */
async function resolvedIncident(a: App, headers: Record<string, string> = {}): Promise<string> {
  const opened = await post(a, "/incidents", { scenarioId: "deploy-5xx-rollback" }, headers);
  assert.equal(opened.statusCode, 201);
  const id = opened.json().incident.id as string;
  const pending = opened.json().approvals.find((x: { status: string }) => x.status === "pending").id as string;
  const ok = await post(a, `/approvals/${pending}/decision`, { decision: "approve", approver: "ana" }, { ...headers, "x-approval-token": TEST_APPROVAL_TOKEN });
  assert.equal(ok.statusCode, 200);
  return id;
}

// =====================================================================================================================

describe("GET /incidents/:id/code-fix (AC-74, AC-79)", () => {
  test("200 with the latest attempt as a redacted view: patch included, contents left out", async () => {
    const { c, a } = setup();
    const id = await resolvedIncident(a);
    insert(c, attemptFor(id, { id: "fix_0000000000000001", startedAt: "2026-10-04T09:00:00.000Z" }), undefined, false);
    insert(c, attemptFor(id));
    const r = await get(a, `/incidents/${id}/code-fix`);
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.id, "fix_0123456789abcdef");
    assert.equal("contents" in body, false);
    assert.equal(CodeFixAttemptViewSchema.strict().safeParse(body).success, true);
    assert.equal(typeof body.patch, "string");
    assert.match(body.patch, /diff --git/);
    assert.match(body.patch, /\[REDACTED\]/);
    assert.ok(!r.body.includes(SECRET));
  });

  test("toCodeFixView redacts by itself and omits contents", () => {
    const { c } = setup();
    const view = toCodeFixView(attemptFor("INC-0001"), c.secrets);
    assert.equal("contents" in view, false);
    assert.ok(!JSON.stringify(view).includes(SECRET));
    assert.match(view.exception!.value, /\[REDACTED\]/);
  });

  test("404 incident_not_found and 404 code_fix_not_found", async () => {
    const { a } = setup();
    const missing = await get(a, "/incidents/INC-9999/code-fix");
    assert.deepEqual([missing.statusCode, missing.json().error.code], [404, "incident_not_found"]);
    const id = await resolvedIncident(a);
    const none = await get(a, `/incidents/${id}/code-fix`);
    assert.deepEqual([none.statusCode, none.json().error.code], [404, "code_fix_not_found"]);

    // Without a codeFix config the route still answers 404 code_fix_not_found.
    const plain = setup({ withCodeFix: false });
    const pid = await resolvedIncident(plain.a);
    const r = await get(plain.a, `/incidents/${pid}/code-fix`);
    assert.deepEqual([r.statusCode, r.json().error.code], [404, "code_fix_not_found"]);
  });

  test("the API_TOKEN rule matches the other routes", async () => {
    const { c, a } = setup({ env: { API_TOKEN } });
    const auth = { authorization: `Bearer ${API_TOKEN}` };
    const id = await resolvedIncident(a, auth);
    insert(c, attemptFor(id));
    const denied = await get(a, `/incidents/${id}/code-fix`);
    assert.deepEqual([denied.statusCode, denied.json().error.code], [401, "invalid_api_token"]);
    const wrong = await get(a, `/incidents/${id}/code-fix`, { authorization: "Bearer wrong-token-0000000000" });
    assert.equal(wrong.statusCode, 401);
    assert.equal((await get(a, `/incidents/${id}`)).statusCode, 401);
    assert.equal((await get(a, `/incidents/${id}/code-fix`, auth)).statusCode, 200);
  });
});

describe("postmortem Code fix section (AC-74)", () => {
  test("Markdown gains the redacted section when an attempt exists; JSON is unchanged", async () => {
    const { c, a } = setup();
    const id = await resolvedIncident(a);
    const before = await get(a, `/incidents/${id}/postmortem`);
    const jsonBefore = (await get(a, `/incidents/${id}/postmortem?format=json`)).body;
    assert.equal(before.statusCode, 200);
    assert.ok(!before.body.includes("## Code fix"));

    const attempt = attemptFor(id);
    insert(c, attempt);
    const after = await get(a, `/incidents/${id}/postmortem`);
    assert.equal(after.statusCode, 200);
    assert.match(after.headers["content-type"] as string, /^text\/markdown; charset=utf-8/);
    const section = redactSecrets(renderCodeFixSection(c.codeFix!.store.getAttempt(attempt.id)!), c.secrets);
    assert.equal(after.body, `${before.body}\n${section}`);
    assert.ok(after.body.trimEnd().endsWith(section.trimEnd()));
    assert.ok(!after.body.includes(SECRET));
    assert.equal(c.incidents.postmortemMarkdown(id), after.body);

    assert.equal((await get(a, `/incidents/${id}/postmortem?format=json`)).body, jsonBefore);
  });

  test("byte-identical to a container without the code fixer when no attempt exists", async () => {
    const plain = setup({ withCodeFix: false });
    const withFixer = setup();
    const p = await resolvedIncident(plain.a);
    const w = await resolvedIncident(withFixer.a);
    assert.equal(p, w);
    assert.equal((await get(withFixer.a, `/incidents/${w}/postmortem`)).body, (await get(plain.a, `/incidents/${p}/postmortem`)).body);
    assert.equal(
      (await get(withFixer.a, `/incidents/${w}/postmortem?format=json`)).body,
      (await get(plain.a, `/incidents/${p}/postmortem?format=json`)).body,
    );
  });
});

describe("GET /approvals with code-fix approvals", () => {
  test("lists the code-fix approval with subject and patchSha256", async () => {
    const { c, a } = setup();
    const id = await resolvedIncident(a);
    const now = c.clock.now();
    const requestedAt = new Date(now.getTime() - 3_600_000).toISOString();
    const expiresAt = new Date(now.getTime() + 71 * 3_600_000).toISOString();
    const approvalId = c.ids.approval();
    const attempt = attemptFor(id, { mode: "draft_pr", status: "awaiting_approval", approvalId, finishedAt: null });
    const approval: Approval = {
      id: approvalId, incidentId: id, actionId: attempt.id, status: "pending", requestedAt, expiresAt, decidedAt: null, approver: null,
      comment: null, decisionSource: null, version: 0, subject: "code_fix", patchSha256: attempt.patchSha256!,
    };
    insert(c, attempt, approval);
    const r = await get(a, "/approvals?status=pending");
    assert.equal(r.statusCode, 200);
    const items = r.json() as Approval[];
    const fix = items.find((x) => x.id === approvalId);
    assert.ok(fix, "the code-fix approval is listed");
    assert.deepEqual([fix.subject, fix.patchSha256, fix.actionId, fix.status], ["code_fix", attempt.patchSha256, attempt.id, "pending"]);
    const view = (await get(a, `/incidents/${id}/code-fix`)).json();
    assert.deepEqual([view.status, view.approvalId], ["awaiting_approval", approvalId]);
  });
});
