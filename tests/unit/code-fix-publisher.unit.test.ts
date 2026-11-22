// CodeFixPublisher (spec 009, decisions 13, 15, 16 and 21; AC-77, AC-79, AC-81, AC-82). The real GitHub reader and writer
// run over a stateful fake GitHub (deterministic SHAs, refs that answer 422 when they exist) behind an injected fetch
// that logs every call; no network. Tokens and secrets are built at run time.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Approval, CodeFixAttempt } from "../../src/contracts/index.ts";
import { createGitHubReader, createGitHubWriter } from "../../src/codehost/github/client.ts";
import type { CodeHostWriter } from "../../src/domain/code-fix/ports.ts";
import { canonicalPatchPayload } from "../../src/domain/code-fix/patch-payload.ts";
import { SqliteCodeFixStore } from "../../src/infra/db/code-fix-store.ts";
import { sha256Hex } from "../../src/app/code-fix-service.ts";
import { CodeFixPublisher } from "../../src/app/code-fix-publisher.ts";
import type { CodeFixPublisherDeps } from "../../src/app/code-fix-publisher.ts";
import { ANCHOR_PATH, SAMPLE_REPO, SHA_HEAD, SHA_RELEASE } from "../helpers/code-fix-fakes.ts";
import { createTestContainer, initialBlackboard } from "../helpers/container.ts";
import type { TestContainer } from "../helpers/container.ts";

const TOKEN = "github_pat_" + "Z9".repeat(35);
const SECRET = "ghp_" + "M4".repeat(18);
const API = "https://api.github.com";
const REPO_PATH = `/repos/${SAMPLE_REPO.repo}`;
const BASE_TREE = "c".repeat(40);
const OTHER_COMMIT = "2".repeat(40);
const OTHER_TREE = "9".repeat(40);
const TEST_PATH = "tests/checkout/cart-summary.regression.test.ts";
const ATTEMPT_ID = "fix_0123456789abcdef";
const BRANCH = `incident-copilot/fix-${ATTEMPT_ID}`;
const PR_URL = "https://github.com/acme/checkout-web/pull/7";
const PUBLIC_URL = "https://copilot.example.invalid";

// ---------- fake GitHub ----------

type GhCall = { method: string; path: string; url: string; body: string | null };

type FakeGitHubOptions = {
  protected?: boolean;
  compare?: string[];
  branchStatus?: number;
  existingPull?: boolean;
  /** The fix branch already exists and points at a commit with another tree. */
  foreignRef?: boolean;
  /** The first POST /pulls fails at the transport. */
  failPullsOnce?: boolean;
  onRequest?: (c: GhCall) => void;
};

/** Every call of every fake in this file, for the "no PUT, PATCH, DELETE or merge" check. */
const ALL_CALLS: GhCall[] = [];

function fakeGitHub(o: FakeGitHubOptions = {}) {
  const calls: GhCall[] = [];
  const commits = new Map<string, { tree: string; parents: string[] }>([[SHA_HEAD, { tree: BASE_TREE, parents: [] }]]);
  const refs = new Map<string, string>();
  const pulls: { number: number; html_url: string; draft: boolean; head: { ref: string; sha: string } }[] = [];
  if (o.foreignRef) {
    commits.set(OTHER_COMMIT, { tree: OTHER_TREE, parents: [SHA_HEAD] });
    refs.set(BRANCH, OTHER_COMMIT);
  }
  if (o.existingPull) pulls.push({ number: 3, html_url: "https://github.com/acme/checkout-web/pull/3", draft: true, head: { ref: BRANCH, sha: OTHER_COMMIT } });
  let pullsFailed = false;
  const h = (s: string) => createHash("sha1").update(s).digest("hex");
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const ghFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const raw = typeof init.body === "string" ? init.body : null;
    const call: GhCall = { method, path: url.pathname, url: url.href, body: raw };
    calls.push(call);
    ALL_CALLS.push(call);
    o.onRequest?.(call);
    if (url.origin !== API || !url.pathname.startsWith(REPO_PATH + "/")) throw new Error(`unexpected request: ${method} ${url.href}`);
    const p = url.pathname.slice(REPO_PATH.length);
    const body = raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
    if (method === "GET" && p === "/branches/main") {
      if (o.branchStatus) return json(o.branchStatus, { message: "unavailable" });
      return json(200, { name: "main", protected: o.protected ?? true, commit: { sha: SHA_HEAD } });
    }
    if (method === "GET" && p === `/compare/${SHA_HEAD}...main`) return json(200, { files: (o.compare ?? []).map((filename) => ({ filename })) });
    if (method === "GET" && p === "/pulls") {
      const head = url.searchParams.get("head") ?? "";
      return json(200, pulls.filter((x) => `acme:${x.head.ref}` === head));
    }
    if (method === "GET" && p.startsWith("/git/commits/")) {
      const sha = p.slice("/git/commits/".length);
      const c = commits.get(sha);
      if (!c) return json(404, { message: "Not Found" });
      return json(200, { sha, tree: { sha: c.tree }, parents: c.parents.map((x) => ({ sha: x })) });
    }
    if (method === "GET" && p.startsWith("/git/ref/heads/")) {
      const branch = p.slice("/git/ref/heads/".length);
      const sha = refs.get(branch);
      return sha ? json(200, { ref: `refs/heads/${branch}`, object: { sha, type: "commit" } }) : json(404, { message: "Not Found" });
    }
    if (method === "POST" && p === "/git/blobs") return json(201, { sha: h(`blob:${String(body!.content)}`) });
    if (method === "POST" && p === "/git/trees") return json(201, { sha: h(`tree:${raw}`) });
    if (method === "POST" && p === "/git/commits") {
      const sha = h(`commit:${raw}`);
      const tree = String(body!.tree);
      const parents = (body!.parents as string[]).map(String);
      commits.set(sha, { tree, parents });
      return json(201, { sha, tree: { sha: tree }, parents: parents.map((x) => ({ sha: x })) });
    }
    if (method === "POST" && p === "/git/refs") {
      const branch = String(body!.ref).replace(/^refs\/heads\//, "");
      if (refs.has(branch)) return json(422, { message: "Reference already exists" });
      refs.set(branch, String(body!.sha));
      return json(201, { ref: body!.ref, object: { sha: body!.sha } });
    }
    if (method === "POST" && p === "/pulls") {
      if (o.failPullsOnce && !pullsFailed) {
        pullsFailed = true;
        throw new TypeError("fetch failed");
      }
      const head = String(body!.head);
      const pr = { number: 7, html_url: PR_URL, draft: body!.draft === true, head: { ref: head, sha: refs.get(head)! } };
      pulls.push(pr);
      return json(201, pr);
    }
    throw new Error(`unexpected request: ${method} ${url.href}`);
  }) as typeof fetch;
  return { fetch: ghFetch, calls, refs, pulls };
}

// ---------- attempt ----------

function artifact(o: { exceptionType?: string } = {}) {
  const source = "export const summarize = (cart) => ({ total: cart.totals?.total ?? 0 });\n";
  const testText = 'import { test } from "node:test";\n// ü\n';
  const contents = [{ path: ANCHOR_PATH, text: source }, { path: TEST_PATH, text: testText }];
  const files = [
    { path: ANCHOR_PATH, role: "source" as const, added: 1, removed: 1, afterSha256: sha256Hex(source) },
    { path: TEST_PATH, role: "test" as const, added: 2, removed: 0, afterSha256: sha256Hex(testText) },
  ];
  const patch = `diff --git a/${ANCHOR_PATH} b/${ANCHOR_PATH}\n--- a/${ANCHOR_PATH}\n+++ b/${ANCHOR_PATH}\n`;
  return { contents, files, patch, patchSha256: sha256Hex(canonicalPatchPayload(patch, files)), exceptionType: o.exceptionType ?? "TypeError" };
}

type Harness = { c: TestContainer; fixes: SqliteCodeFixStore; publisher: CodeFixPublisher; gh: ReturnType<typeof fakeGitHub>; attempt: CodeFixAttempt; approval: Approval };

function harness(o: FakeGitHubOptions & {
  status?: CodeFixAttempt["status"];
  exceptionType?: string;
  exceptionValue?: string;
  classify?: CodeFixPublisherDeps["classify"];
  writer?: (real: CodeHostWriter) => CodeHostWriter;
} = {}): Harness {
  const c = createTestContainer();
  const fixes = new SqliteCodeFixStore(c.store);
  const incidentId = initialBlackboard(c, "deploy-5xx-rollback").incidentId;
  const art = artifact({ ...(o.exceptionType ? { exceptionType: o.exceptionType } : {}) });
  const nowIso = c.clock.now().toISOString();
  const approvalId = c.ids.approval();
  const attempt: CodeFixAttempt = {
    id: ATTEMPT_ID, incidentId, repo: SAMPLE_REPO.repo, service: SAMPLE_REPO.service, connectorId: "sentry", errorGroupId: "4815162342",
    mode: "draft_pr", isolation: "isolated", status: o.status ?? "approved", stage: "finalize", reason: null, violations: [],
    release: "checkout-web@2026.10.04-1", commitSha: SHA_RELEASE, baseBranch: "main", baseCommitSha: SHA_HEAD,
    exception: { type: art.exceptionType, value: o.exceptionValue ?? "Cannot read properties of undefined (reading 'total')" },
    anchor: { file: ANCHOR_PATH, line: 27, column: 3, function: "summarize", inApp: true },
    files: art.files, patch: art.patch, patchSha256: art.patchSha256, contents: art.contents,
    evidence: { baseline: null, reproBefore: [], fixAfter: [], suiteAfter: null }, review: { verdict: "approve", concerns: [] },
    suggestion: null, approvalId, commit: null, pullRequest: null, llm: { calls: 3, promptTokens: 10, completionTokens: 10 },
    startedAt: nowIso, patchReadyAt: "2026-10-04T10:00:00.000Z", finishedAt: null, version: 0,
  };
  const approval: Approval = {
    id: approvalId, incidentId, actionId: ATTEMPT_ID, status: "approved", requestedAt: nowIso, expiresAt: new Date(Date.parse(nowIso) + 72 * 3_600_000).toISOString(),
    decidedAt: nowIso, approver: "ana", comment: null, decisionSource: "structured", version: 1, subject: "code_fix", patchSha256: art.patchSha256,
  };
  fixes.transaction(() => {
    fixes.insertAttempt(attempt, { keyHeld: true });
    fixes.insertApproval(approval);
  });
  const gh = fakeGitHub(o);
  const cfg = { apiUrl: API, token: TOKEN, repositories: [SAMPLE_REPO.repo] };
  const reader = createGitHubReader(cfg, { fetch: gh.fetch, logger: c.logger });
  const realWriter = createGitHubWriter(cfg, { fetch: gh.fetch, logger: c.logger });
  const publisher = new CodeFixPublisher({
    store: c.store, fixes, config: { repositories: [{ ...SAMPLE_REPO }], commitAuthor: { name: "incident-copilot", email: "incident-copilot@example.invalid" } },
    reader, writer: o.writer ? o.writer(realWriter) : realWriter, clock: c.clock, logger: c.logger, secrets: [TOKEN, SECRET], publicUrl: PUBLIC_URL,
    ...(o.classify ? { classify: o.classify } : {}),
  });
  return { c, fixes, publisher, gh, attempt: fixes.getAttempt(ATTEMPT_ID)!, approval };
}

const seq = (calls: readonly GhCall[]) => calls.map((x) => `${x.method} ${x.path.replace(REPO_PATH, "")}`);
const posts = (calls: readonly GhCall[]) => calls.filter((x) => x.method === "POST");
const publishAudits = (h: Harness) => h.c.store.listAudit(h.attempt.incidentId).filter((e) => e.event === "code_fix_pr_opened" || e.event === "code_fix_publish_failed");

function assertFailed(h: Harness, reason: string, o: { kind?: string | null; keyHeld: boolean }) {
  const a = h.fixes.getAttempt(ATTEMPT_ID)!;
  assert.equal(a.status, "publish_failed");
  assert.equal(a.reason, reason);
  assert.equal(a.stage, "publish");
  assert.ok(a.finishedAt);
  assert.equal(h.fixes.holdsKey(a.repo, a.errorGroupId), o.keyHeld);
  const audits = publishAudits(h);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.event, "code_fix_publish_failed");
  assert.equal(audits[0]!.actor, "system:code-fix-publisher");
  assert.equal(audits[0]!.tier, 3);
  assert.deepEqual(audits[0]!.details, { attemptId: ATTEMPT_ID, reason, kind: o.kind ?? null });
}

function assertNoTokenAnywhere(h: Harness) {
  for (const call of h.gh.calls) {
    assert.ok(!call.url.includes(TOKEN), "token in a URL");
    assert.ok(!(call.body ?? "").includes(TOKEN), "token in a body");
  }
  assert.ok(!JSON.stringify(h.c.store.listAudit(h.attempt.incidentId)).includes(TOKEN));
  assert.ok(!JSON.stringify(h.fixes.getAttempt(ATTEMPT_ID)).includes(TOKEN));
  assert.ok(!h.c.logs.join("\n").includes(TOKEN));
}

// =====================================================================================================================

describe("CodeFixPublisher.publish (AC-77)", () => {
  test("the happy path does the exact sequence, persists the commit before POST refs and ends pr_opened", async () => {
    let commitAtRef: CodeFixAttempt["commit"] | undefined;
    let statusAtFirstRequest: string | undefined;
    let fixes: SqliteCodeFixStore | null = null;
    const h = harness({
      onRequest: (call) => {
        if (statusAtFirstRequest === undefined) statusAtFirstRequest = fixes!.getAttempt(ATTEMPT_ID)!.status;
        if (call.method === "POST" && call.path.endsWith("/git/refs")) commitAtRef = fixes!.getAttempt(ATTEMPT_ID)!.commit;
      },
    });
    fixes = h.fixes;
    await h.publisher.publish(ATTEMPT_ID);
    assert.equal(statusAtFirstRequest, "publishing");
    assert.deepEqual(seq(h.gh.calls), [
      "GET /branches/main",
      `GET /compare/${SHA_HEAD}...main`,
      "GET /pulls",
      `GET /git/commits/${SHA_HEAD}`,
      "POST /git/blobs",
      "POST /git/blobs",
      "POST /git/trees",
      "POST /git/commits",
      "POST /git/refs",
      "POST /pulls",
    ]);
    const a = h.fixes.getAttempt(ATTEMPT_ID)!;
    assert.equal(a.status, "pr_opened");
    assert.equal(a.reason, null);
    assert.equal(a.stage, "publish");
    assert.ok(a.finishedAt);
    assert.deepEqual(a.pullRequest, { number: 7, url: PR_URL, branch: BRANCH });
    assert.ok(a.commit);
    assert.deepEqual(commitAtRef, a.commit, "the commit sha is persisted before POST refs");
    assert.equal(h.gh.refs.get(BRANCH), a.commit.sha);
    assert.equal(h.fixes.holdsKey(a.repo, a.errorGroupId), true);

    const commitBody = JSON.parse(posts(h.gh.calls).find((x) => x.path.endsWith("/git/commits"))!.body!) as Record<string, unknown>;
    assert.deepEqual(commitBody.parents, [SHA_HEAD]);
    const sig = { name: "incident-copilot", email: "incident-copilot@example.invalid", date: "2026-10-04T10:00:00.000Z" };
    assert.deepEqual(commitBody.author, sig);
    assert.deepEqual(commitBody.committer, sig);
    assert.doesNotMatch(String(commitBody.message), /co-authored-by|generated with/i);
    const treeBody = JSON.parse(posts(h.gh.calls).find((x) => x.path.endsWith("/git/trees"))!.body!) as { base_tree: string; tree: { path: string }[] };
    assert.equal(treeBody.base_tree, BASE_TREE);
    assert.deepEqual(treeBody.tree.map((t) => t.path).sort(), [ANCHOR_PATH, TEST_PATH].sort());
    const pull = JSON.parse(posts(h.gh.calls).find((x) => x.path.endsWith("/pulls"))!.body!) as Record<string, unknown>;
    assert.equal(pull.draft, true);
    assert.equal(pull.maintainer_can_modify, false);
    assert.equal(pull.head, BRANCH);
    assert.equal(pull.base, "main");
    assert.ok(String(pull.body).includes(`${PUBLIC_URL}/incidents/${h.attempt.incidentId}`));
    assert.doesNotMatch(String(pull.body), /co-authored-by|generated with/i);

    const audits = publishAudits(h);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.event, "code_fix_pr_opened");
    assert.equal(audits[0]!.actor, "system:code-fix-publisher");
    assert.equal(audits[0]!.tier, 3);
    assert.deepEqual(audits[0]!.details, { attemptId: ATTEMPT_ID, prNumber: 7, prUrl: PR_URL, branch: BRANCH, patchSha256: h.attempt.patchSha256 });
    assertNoTokenAnywhere(h);
  });

  test("a tampered patch gives publish_failed/patch_mismatch with zero requests", async () => {
    const h = harness();
    h.fixes.updateAttempt(ATTEMPT_ID, { ...h.attempt, patch: h.attempt.patch + "+evil\n" }, h.attempt.version);
    await h.publisher.publish(ATTEMPT_ID);
    assert.equal(h.gh.calls.length, 0);
    assertFailed(h, "patch_mismatch", { keyHeld: true });
  });

  test("a tampered post-image gives publish_failed/patch_mismatch with zero requests", async () => {
    const h = harness();
    const contents = h.attempt.contents.map((x, i) => (i === 0 ? { ...x, text: x.text + "// backdoor\n" } : x));
    h.fixes.updateAttempt(ATTEMPT_ID, { ...h.attempt, contents }, h.attempt.version);
    await h.publisher.publish(ATTEMPT_ID);
    assert.equal(h.gh.calls.length, 0);
    assertFailed(h, "patch_mismatch", { keyHeld: true });
  });

  test("an approval bound to another hash gives patch_mismatch", async () => {
    const h = harness();
    h.fixes.transitionApproval(h.approval.id, { ...h.approval, patchSha256: "0".repeat(64) }, h.approval.version);
    await h.publisher.publish(ATTEMPT_ID);
    assert.equal(h.gh.calls.length, 0);
    assertFailed(h, "patch_mismatch", { keyHeld: true });
  });

  test("a reclassification that is not tier 3 gives catalog_refused", async () => {
    const h = harness({ classify: (() => ({ tier: 4, reasons: [], known: true, executable: true, paramsOk: true, params: null })) as never });
    await h.publisher.publish(ATTEMPT_ID);
    assert.equal(h.gh.calls.length, 0);
    assertFailed(h, "catalog_refused", { keyHeld: true });
  });

  test("an unprotected base branch gives base_unprotected, with no POST", async () => {
    const h = harness({ protected: false });
    await h.publisher.publish(ATTEMPT_ID);
    assert.deepEqual(seq(h.gh.calls), ["GET /branches/main"]);
    assertFailed(h, "base_unprotected", { keyHeld: true });
  });

  test("a compare that lists a patched file gives stale_base, with no POST", async () => {
    const h = harness({ compare: ["README.md", ANCHOR_PATH] });
    await h.publisher.publish(ATTEMPT_ID);
    assert.equal(posts(h.gh.calls).length, 0);
    assertFailed(h, "stale_base", { keyHeld: true });
  });

  test("an unrelated change on the base does not block the publish", async () => {
    const h = harness({ compare: ["README.md"] });
    await h.publisher.publish(ATTEMPT_ID);
    assert.equal(h.fixes.getAttempt(ATTEMPT_ID)!.status, "pr_opened");
  });

  test("an existing pull request is reused, with no POST", async () => {
    const h = harness({ existingPull: true });
    await h.publisher.publish(ATTEMPT_ID);
    assert.equal(posts(h.gh.calls).length, 0);
    const a = h.fixes.getAttempt(ATTEMPT_ID)!;
    assert.equal(a.status, "pr_opened");
    assert.deepEqual(a.pullRequest, { number: 3, url: "https://github.com/acme/checkout-web/pull/3", branch: BRANCH });
    assert.equal(publishAudits(h)[0]!.event, "code_fix_pr_opened");
  });

  test("a crash between POST refs and POST pulls, then a retry: same commit, the 422 ref is accepted, the PR opens", async () => {
    let crash = true;
    const h = harness({
      failPullsOnce: true,
      writer: (real) => ({
        async openDraftPullRequest(input) {
          try {
            return await real.openDraftPullRequest(input);
          } catch (e) {
            if (!crash) throw e;
            crash = false;
            throw new Error("simulated process crash");
          }
        },
      }),
    });
    await h.publisher.publish(ATTEMPT_ID);
    const mid = h.fixes.getAttempt(ATTEMPT_ID)!;
    assert.equal(mid.status, "publishing", "a crash leaves the attempt publishing for recover()");
    assert.ok(mid.commit);
    assert.equal(h.gh.refs.get(BRANCH), mid.commit.sha);
    assert.equal(publishAudits(h).length, 0);

    const before = h.gh.calls.length;
    await h.publisher.publish(ATTEMPT_ID);
    const retry = h.gh.calls.slice(before);
    assert.deepEqual(seq(retry).filter((x) => x.startsWith("POST")), [
      "POST /git/blobs", "POST /git/blobs", "POST /git/trees", "POST /git/commits", "POST /git/refs", "POST /pulls",
    ]);
    assert.ok(seq(retry).includes(`GET /git/ref/heads/${BRANCH}`));
    const a = h.fixes.getAttempt(ATTEMPT_ID)!;
    assert.equal(a.status, "pr_opened");
    assert.deepEqual(a.commit, mid.commit, "the retry builds the same commit");
    assert.equal(a.pullRequest!.number, 7);
    assert.equal(h.gh.pulls.length, 1);
    assert.deepEqual(publishAudits(h).map((e) => e.event), ["code_fix_pr_opened"]);
  });

  test("a ref pointing at another tree gives ref_conflict", async () => {
    const h = harness({ foreignRef: true });
    await h.publisher.publish(ATTEMPT_ID);
    assert.equal(posts(h.gh.calls).filter((x) => x.path.endsWith("/pulls")).length, 0);
    assertFailed(h, "ref_conflict", { kind: "conflict", keyHeld: true });
  });

  test("a code-host error gives publish_failed/codehost_error with its kind and releases the key", async () => {
    const h = harness({ branchStatus: 503 });
    await h.publisher.publish(ATTEMPT_ID);
    assertFailed(h, "codehost_error", { kind: "unavailable", keyHeld: false });
    assertNoTokenAnywhere(h);
  });

  test("an attempt that is not approved or publishing is left alone", async () => {
    const h = harness({ status: "awaiting_approval" });
    await h.publisher.publish(ATTEMPT_ID);
    assert.equal(h.gh.calls.length, 0);
    assert.equal(h.fixes.getAttempt(ATTEMPT_ID)!.status, "awaiting_approval");
    assert.equal(publishAudits(h).length, 0);
  });

  test("an unknown attempt never throws", async () => {
    const h = harness();
    await h.publisher.publish("fix_ffffffffffffffff");
    assert.equal(h.gh.calls.length, 0);
  });
});

describe("redaction (AC-79)", () => {
  test("the title, body and commit message pass through redaction, and the token never appears", async () => {
    const h = harness({ exceptionType: `TypeError ${SECRET}`, exceptionValue: `leaked ${SECRET} here` });
    await h.publisher.publish(ATTEMPT_ID);
    assert.equal(h.fixes.getAttempt(ATTEMPT_ID)!.status, "pr_opened");
    const pull = JSON.parse(posts(h.gh.calls).find((x) => x.path.endsWith("/pulls"))!.body!) as { title: string; body: string };
    const commit = JSON.parse(posts(h.gh.calls).find((x) => x.path.endsWith("/git/commits"))!.body!) as { message: string };
    for (const text of [pull.title, pull.body, commit.message]) {
      assert.ok(!text.includes(SECRET), "a secret left the process");
      assert.ok(!text.includes(TOKEN));
    }
    assert.ok(pull.title.includes("[REDACTED]"));
    assert.ok(pull.body.includes("[REDACTED]"));
    assertNoTokenAnywhere(h);
  });
});

describe("least privilege (AC-77)", () => {
  test("no PUT, PATCH, DELETE or merge call was seen in any test", () => {
    assert.ok(ALL_CALLS.length > 0);
    for (const call of ALL_CALLS) {
      assert.ok(call.method === "GET" || call.method === "POST", `${call.method} ${call.path}`);
      assert.doesNotMatch(call.path, /\/merge|\/reviews|\/labels/);
    }
  });
});
