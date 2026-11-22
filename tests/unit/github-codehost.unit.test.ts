// GitHub code host (spec 009, decisions 15 and 20; AC-77, AC-78, AC-79). Every request goes through a fake fetch that
// logs each call and rejects any unknown method or path; the token is built at run time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createFakeFetch, type FakeCall, type FakeRoute } from "../helpers/fake-fetch.ts";
import { createGitHubReader, createGitHubWriter, type GitHubCodeHostConfig } from "../../src/codehost/github/client.ts";
import { CodeHostError } from "../../src/codehost/github/errors.ts";
import type { Logger, LogFields } from "../../src/infra/logger.ts";

const API = "https://api.github.com";
const TOKEN = "github_pat_" + "a".repeat(70);
const OWNER = "acme";
const REPO = "shop";
const R = `${API}/repos/${OWNER}/${REPO}`;
const BASE_SHA = "b".repeat(40);
const BASE_TREE = "c".repeat(40);
const BLOB_1 = "d".repeat(40);
const BLOB_2 = "e".repeat(40);
const TREE = "f".repeat(40);
const COMMIT = "1".repeat(40);
const OTHER = "2".repeat(40);
const BRANCH = "incident-copilot/fix-FIX-0001";
const PR_URL = "https://github.com/acme/shop/pull/7";

const cfg = (o: Partial<GitHubCodeHostConfig> = {}): GitHubCodeHostConfig => ({
  apiUrl: API,
  token: TOKEN,
  repositories: [`${OWNER}/${REPO}`],
  ...o,
});

function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const make = (b: LogFields): Logger => {
    const emit = (level: string) => (msg: string, f?: LogFields) => void lines.push(JSON.stringify({ level, msg, ...b, ...f }));
    return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error"), child: (f) => make({ ...b, ...f }) };
  };
  return { logger: make({}), lines };
}

function setup(routes: FakeRoute[], o: { config?: Partial<GitHubCodeHostConfig>; timeoutMs?: number } = {}) {
  const fake = createFakeFetch(routes);
  const log = captureLogger();
  const deps = { fetch: fake.fetch, logger: log.logger, ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}) };
  return {
    reader: createGitHubReader(cfg(o.config), deps),
    // A writer needs a token; a token-less setup only exercises the reader.
    writer: cfg(o.config).token ? createGitHubWriter(cfg(o.config), deps) : (null as never),
    calls: fake.calls,
    lines: log.lines,
  };
}

async function rejectsKind(p: Promise<unknown>, kind: string): Promise<CodeHostError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof CodeHostError, `expected CodeHostError, got ${String(e)}`);
    assert.equal(e.kind, kind);
    assert.equal(e.name, "CodeHostError");
    return e;
  }
  assert.fail(`expected CodeHostError(${kind})`);
}

const pathOf = (url: string) => new URL(url).pathname;

/**
 * A route body that answers the next value on each request. The fake fetch reads `body` more than once per request, so
 * the value is memoized by the number of calls logged so far (constant within one request).
 */
function sequenced(values: unknown[], calls: () => FakeCall[]): { readonly body: unknown } {
  const byCall = new Map<number, unknown>();
  let next = 0;
  return {
    get body() {
      const k = calls().length;
      if (!byCall.has(k)) byCall.set(k, values[Math.min(next++, values.length - 1)]);
      return byCall.get(k);
    },
  };
}

const PULLS_LIST = new RegExp(`^${R.replace(/[.]/g, "\\.")}/pulls\\?`);
const prBody = (n = 7) => ({ number: n, html_url: PR_URL, draft: true, head: { ref: BRANCH, sha: COMMIT } });

const openInput = (o: Partial<Parameters<ReturnType<typeof createGitHubWriter>["openDraftPullRequest"]>[0]> = {}) => ({
  owner: OWNER,
  repo: REPO,
  base: "main",
  baseCommitSha: BASE_SHA,
  branch: BRANCH,
  title: "Fix: guard empty cart",
  body: "Draft pull request body",
  commitMessage: "fix: guard empty cart",
  author: { name: "incident-copilot", email: "incident-copilot@example.invalid", date: "2026-11-21T10:00:00Z" },
  files: [
    { path: "src/cart.js", content: "export const total = (xs) => xs.reduce((a, b) => a + b, 0);\n" },
    { path: "test/cart.test.js", content: "// regression ü\n" },
  ],
  ...o,
});

/** The happy-path routes, with the two POSTs that may fail with 422 overridable. */
function writeRoutes(o: { refs?: FakeRoute; pulls?: FakeRoute; list?: unknown[]; extra?: FakeRoute[] } = {}): FakeRoute[] {
  return [
    { method: "GET", url: PULLS_LIST, body: o.list ?? [] },
    { method: "GET", url: `${R}/git/commits/${BASE_SHA}`, body: { sha: BASE_SHA, tree: { sha: BASE_TREE }, parents: [{ sha: OTHER }] } },
    { method: "POST", url: `${R}/git/blobs`, body: { sha: BLOB_1 } },
    { method: "POST", url: `${R}/git/trees`, status: 201, body: { sha: TREE } },
    { method: "POST", url: `${R}/git/commits`, status: 201, body: { sha: COMMIT, tree: { sha: TREE }, parents: [{ sha: BASE_SHA }] } },
    o.refs ?? { method: "POST", url: `${R}/git/refs`, status: 201, body: { ref: `refs/heads/${BRANCH}`, object: { sha: COMMIT } } },
    o.pulls ?? { method: "POST", url: `${R}/pulls`, status: 201, body: prBody() },
    ...(o.extra ?? []),
  ];
}

// ---------- reader ----------

test("commitExists is true on 200 and false on 404", async () => {
  const { reader, calls } = setup([
    { method: "GET", url: `${R}/git/commits/${BASE_SHA}`, body: { sha: BASE_SHA, tree: { sha: BASE_TREE }, parents: [] } },
    { method: "GET", url: `${R}/git/commits/${OTHER}`, status: 404, body: { message: "Not Found" } },
  ]);
  assert.equal(await reader.commitExists({ owner: OWNER, repo: REPO, sha: BASE_SHA }), true);
  assert.equal(await reader.commitExists({ owner: OWNER, repo: REPO, sha: OTHER }), false);
  assert.equal(calls.length, 2);
});

test("branchInfo reports protection and the head sha", async () => {
  const { reader, calls } = setup([
    { method: "GET", url: `${R}/branches/main`, body: { name: "main", protected: true, commit: { sha: BASE_SHA } } },
  ]);
  assert.deepEqual(await reader.branchInfo({ owner: OWNER, repo: REPO, branch: "main" }), { name: "main", protected: true, headSha: BASE_SHA });
  assert.equal(calls.length, 1);
});

test("compareFiles lists the changed paths, renames included", async () => {
  const { reader, calls } = setup([
    {
      method: "GET",
      url: `${R}/compare/${BASE_SHA}...main`,
      body: { status: "ahead", files: [{ filename: "src/a.js", status: "modified" }, { filename: "src/c.js", previous_filename: "src/b.js", status: "renamed" }] },
    },
  ]);
  assert.deepEqual(await reader.compareFiles({ owner: OWNER, repo: REPO, base: BASE_SHA, head: "main" }), ["src/a.js", "src/c.js", "src/b.js"]);
  assert.equal(calls.length, 1);
});

test("compareFiles fails closed when the list may be truncated", async () => {
  const files = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.js` }));
  const { reader } = setup([{ method: "GET", url: `${R}/compare/${BASE_SHA}...main`, body: { files } }]);
  await rejectsKind(reader.compareFiles({ owner: OWNER, repo: REPO, base: BASE_SHA, head: "main" }), "bad_response");
});

test("findPullByHead queries head=owner:branch with state=all", async () => {
  const { reader, calls } = setup([{ method: "GET", url: PULLS_LIST, body: [prBody(9)] }]);
  assert.deepEqual(await reader.findPullByHead({ owner: OWNER, repo: REPO, branch: BRANCH }), { number: 9, url: PR_URL, branch: BRANCH, draft: true });
  const u = new URL(calls[0]!.url);
  assert.equal(u.pathname, `/repos/${OWNER}/${REPO}/pulls`);
  assert.equal(u.searchParams.get("head"), `${OWNER}:${BRANCH}`);
  assert.equal(u.searchParams.get("state"), "all");
});

test("findPullByHead returns null for an empty list", async () => {
  const { reader } = setup([{ method: "GET", url: PULLS_LIST, body: [] }]);
  assert.equal(await reader.findPullByHead({ owner: OWNER, repo: REPO, branch: BRANCH }), null);
});

test("getRef returns the ref and its sha, or null on 404", async () => {
  const { reader, calls } = setup([
    { method: "GET", url: `${R}/git/ref/heads/${BRANCH}`, body: { ref: `refs/heads/${BRANCH}`, object: { sha: COMMIT, type: "commit" } } },
    { method: "GET", url: `${R}/git/ref/heads/incident-copilot/fix-none`, status: 404, body: { message: "Not Found" } },
  ]);
  assert.deepEqual(await reader.getRef({ owner: OWNER, repo: REPO, ref: `refs/heads/${BRANCH}` }), { ref: `refs/heads/${BRANCH}`, sha: COMMIT });
  assert.equal(await reader.getRef({ owner: OWNER, repo: REPO, ref: "heads/incident-copilot/fix-none" }), null);
  assert.equal(calls.length, 2);
});

test("getCommit returns tree and parents", async () => {
  const { reader } = setup([
    { method: "GET", url: `${R}/git/commits/${COMMIT}`, body: { sha: COMMIT, tree: { sha: TREE }, parents: [{ sha: BASE_SHA }] } },
  ]);
  assert.deepEqual(await reader.getCommit({ owner: OWNER, repo: REPO, sha: COMMIT }), { sha: COMMIT, tree: TREE, parents: [BASE_SHA] });
});

// ---------- writer ----------

test("openDraftPullRequest makes the exact sequence and persists the commit before the ref", async () => {
  const order: string[] = [];
  let log: FakeCall[] = [];
  const routes = writeRoutes();
  const blobs = sequenced([{ sha: BLOB_1 }, { sha: BLOB_2 }], () => log);
  routes[2] = Object.defineProperties({ method: "POST", url: `${R}/git/blobs`, status: 201 }, { body: { get: () => blobs.body } }) as FakeRoute;
  const { writer, calls } = setup(routes);
  log = calls;
  const result = await writer.openDraftPullRequest(
    openInput({
      onCommit: (c) => {
        order.push(`commit:${c.sha}:${c.tree}:${calls.length}`);
      },
    }),
  );
  assert.deepEqual(result, { number: 7, url: PR_URL, branch: BRANCH, draft: true, commitSha: COMMIT, treeSha: TREE });
  assert.deepEqual(
    calls.map((c) => `${c.method} ${pathOf(c.url)}`),
    [
      `GET /repos/acme/shop/pulls`,
      `GET /repos/acme/shop/git/commits/${BASE_SHA}`,
      "POST /repos/acme/shop/git/blobs",
      "POST /repos/acme/shop/git/blobs",
      "POST /repos/acme/shop/git/trees",
      "POST /repos/acme/shop/git/commits",
      "POST /repos/acme/shop/git/refs",
      "POST /repos/acme/shop/pulls",
    ],
  );
  // onCommit ran after POST commits (6 calls) and before POST refs.
  assert.deepEqual(order, [`commit:${COMMIT}:${TREE}:6`]);

  const body = (i: number) => JSON.parse(calls[i]!.body!) as Record<string, unknown>;
  const input = openInput();
  assert.deepEqual(body(2), { content: Buffer.from(input.files[0]!.content, "utf8").toString("base64"), encoding: "base64" });
  assert.deepEqual(body(3), { content: Buffer.from(input.files[1]!.content, "utf8").toString("base64"), encoding: "base64" });
  assert.deepEqual(body(4), {
    base_tree: BASE_TREE,
    tree: [
      { path: "src/cart.js", mode: "100644", type: "blob", sha: BLOB_1 },
      { path: "test/cart.test.js", mode: "100644", type: "blob", sha: BLOB_2 },
    ],
  });
  assert.deepEqual(body(5), {
    message: "fix: guard empty cart",
    tree: TREE,
    parents: [BASE_SHA],
    author: { name: "incident-copilot", email: "incident-copilot@example.invalid", date: "2026-11-21T10:00:00Z" },
    committer: { name: "incident-copilot", email: "incident-copilot@example.invalid", date: "2026-11-21T10:00:00Z" },
  });
  assert.deepEqual(body(6), { ref: `refs/heads/${BRANCH}`, sha: COMMIT });
  assert.deepEqual(body(7), {
    title: "Fix: guard empty cart",
    head: BRANCH,
    base: "main",
    body: "Draft pull request body",
    draft: true,
    maintainer_can_modify: false,
  });
});

test("an existing pull request is returned without any POST", async () => {
  const { writer, calls } = setup(writeRoutes({ list: [prBody(3)] }));
  let committed = false;
  const result = await writer.openDraftPullRequest(openInput({ onCommit: () => void (committed = true) }));
  assert.deepEqual(result, { number: 3, url: PR_URL, branch: BRANCH, draft: true, commitSha: COMMIT, treeSha: null });
  assert.equal(calls.length, 1);
  assert.ok(calls.every((c) => c.method === "GET"));
  assert.equal(committed, false);
});

test("422 on refs is accepted when the existing ref points at our commit", async () => {
  const { writer, calls } = setup(
    writeRoutes({
      refs: { method: "POST", url: `${R}/git/refs`, status: 422, body: { message: "Reference already exists" } },
      extra: [{ method: "GET", url: `${R}/git/ref/heads/${BRANCH}`, body: { ref: `refs/heads/${BRANCH}`, object: { sha: COMMIT } } }],
    }),
  );
  const result = await writer.openDraftPullRequest(openInput());
  assert.equal(result.commitSha, COMMIT);
  assert.deepEqual(calls.slice(-2).map((c) => `${c.method} ${pathOf(c.url)}`), [`GET /repos/acme/shop/git/ref/heads/${BRANCH}`, "POST /repos/acme/shop/pulls"]);
});

test("422 on refs is accepted when the ref's commit has our tree and parents [base]", async () => {
  const { writer, calls } = setup(
    writeRoutes({
      refs: { method: "POST", url: `${R}/git/refs`, status: 422, body: { message: "Reference already exists" } },
      extra: [
        { method: "GET", url: `${R}/git/ref/heads/${BRANCH}`, body: { ref: `refs/heads/${BRANCH}`, object: { sha: OTHER } } },
        { method: "GET", url: `${R}/git/commits/${OTHER}`, body: { sha: OTHER, tree: { sha: TREE }, parents: [{ sha: BASE_SHA }] } },
      ],
    }),
  );
  const result = await writer.openDraftPullRequest(openInput());
  assert.equal(result.commitSha, OTHER);
  assert.equal(result.treeSha, TREE);
  assert.equal(calls.at(-1)!.method, "POST");
  assert.equal(pathOf(calls.at(-1)!.url), "/repos/acme/shop/pulls");
});

for (const [label, commit] of [
  ["another tree", { sha: OTHER, tree: { sha: BASE_TREE }, parents: [{ sha: BASE_SHA }] }],
  ["other parents", { sha: OTHER, tree: { sha: TREE }, parents: [{ sha: BASE_SHA }, { sha: COMMIT }] }],
] as const) {
  test(`422 on refs with ${label} is a conflict and opens no pull request`, async () => {
    const { writer, calls } = setup(
      writeRoutes({
        refs: { method: "POST", url: `${R}/git/refs`, status: 422, body: { message: "Reference already exists" } },
        extra: [
          { method: "GET", url: `${R}/git/ref/heads/${BRANCH}`, body: { ref: `refs/heads/${BRANCH}`, object: { sha: OTHER } } },
          { method: "GET", url: `${R}/git/commits/${OTHER}`, body: commit },
        ],
      }),
    );
    await rejectsKind(writer.openDraftPullRequest(openInput()), "conflict");
    assert.ok(!calls.some((c) => c.method === "POST" && pathOf(c.url).endsWith("/pulls")));
  });
}

test("422 on pulls looks the pull request up by head", async () => {
  const routes = writeRoutes({ pulls: { method: "POST", url: `${R}/pulls`, status: 422, body: { message: "A pull request already exists" } } });
  let log: FakeCall[] = [];
  const lists = sequenced([[], [prBody(11)]], () => log);
  routes[0] = Object.defineProperties({ method: "GET", url: PULLS_LIST }, { body: { get: () => lists.body } }) as FakeRoute;
  const { writer, calls } = setup(routes);
  log = calls;
  const result = await writer.openDraftPullRequest(openInput());
  assert.deepEqual(result, { number: 11, url: PR_URL, branch: BRANCH, draft: true, commitSha: COMMIT, treeSha: TREE });
  assert.equal(calls.at(-1)!.method, "GET");
  assert.equal(pathOf(calls.at(-1)!.url), "/repos/acme/shop/pulls");
});

test("422 on pulls with no pull request found is a conflict", async () => {
  const { writer } = setup(writeRoutes({ pulls: { method: "POST", url: `${R}/pulls`, status: 422, body: { message: "Validation Failed" } } }));
  await rejectsKind(writer.openDraftPullRequest(openInput()), "conflict");
});

test("a branch outside incident-copilot/fix-* is unsafe input", async () => {
  const { writer, calls } = setup(writeRoutes());
  await rejectsKind(writer.openDraftPullRequest(openInput({ branch: "main" })), "unsafe_input");
  await rejectsKind(writer.openDraftPullRequest(openInput({ branch: "incident-copilot/fix-../x" })), "unsafe_input");
  assert.equal(calls.length, 0);
});

test("an unsafe file path or an empty file list is unsafe input", async () => {
  const { writer, calls } = setup(writeRoutes());
  for (const path of ["../etc/passwd", "/abs.js", "a/../../b.js", "", "a\\b.js", "a\u0000b.js"]) {
    await rejectsKind(writer.openDraftPullRequest(openInput({ files: [{ path, content: "x" }] })), "unsafe_input");
  }
  await rejectsKind(writer.openDraftPullRequest(openInput({ files: [] })), "unsafe_input");
  assert.equal(calls.length, 0);
});

// ---------- allowlist and input checks ----------

test("a repository outside the allowlist or an unsafe owner throws unsafe_input with zero fetch calls", async () => {
  const { reader, writer, calls } = setup(writeRoutes());
  await rejectsKind(reader.commitExists({ owner: "other", repo: REPO, sha: BASE_SHA }), "unsafe_input");
  await rejectsKind(reader.branchInfo({ owner: "../x", repo: REPO, branch: "main" }), "unsafe_input");
  await rejectsKind(reader.getCommit({ owner: "..", repo: REPO, sha: BASE_SHA }), "unsafe_input");
  await rejectsKind(reader.compareFiles({ owner: OWNER, repo: "shop/../x", base: BASE_SHA, head: "main" }), "unsafe_input");
  await rejectsKind(writer.openDraftPullRequest(openInput({ owner: "evil" })), "unsafe_input");
  await rejectsKind(writer.openDraftPullRequest(openInput({ repo: "../shop" })), "unsafe_input");
  assert.equal(calls.length, 0);
});

test("a malformed sha, branch or ref throws unsafe_input with zero fetch calls", async () => {
  const { reader, writer, calls } = setup([]);
  await rejectsKind(reader.commitExists({ owner: OWNER, repo: REPO, sha: "HEAD" }), "unsafe_input");
  await rejectsKind(reader.getCommit({ owner: OWNER, repo: REPO, sha: "b".repeat(39) }), "unsafe_input");
  await rejectsKind(reader.branchInfo({ owner: OWNER, repo: REPO, branch: "../main" }), "unsafe_input");
  await rejectsKind(reader.branchInfo({ owner: OWNER, repo: REPO, branch: "main?x=1" }), "unsafe_input");
  await rejectsKind(reader.compareFiles({ owner: OWNER, repo: REPO, base: BASE_SHA, head: "a...b" }), "unsafe_input");
  await rejectsKind(reader.getRef({ owner: OWNER, repo: REPO, ref: "refs/tags/v1" }), "unsafe_input");
  await rejectsKind(writer.openDraftPullRequest(openInput({ baseCommitSha: "main" })), "unsafe_input");
  assert.equal(calls.length, 0);
});

test("the allowlist match ignores case, as GitHub names do", async () => {
  const { reader } = setup([{ method: "GET", url: `${API}/repos/Acme/Shop/branches/main`, body: { name: "main", protected: false, commit: { sha: BASE_SHA } } }]);
  assert.equal((await reader.branchInfo({ owner: "Acme", repo: "Shop", branch: "main" })).protected, false);
});

test("the API URL must be https (http only for loopback)", () => {
  const f = createFakeFetch([]).fetch;
  assert.throws(() => createGitHubReader(cfg({ apiUrl: "http://api.github.com" }), { fetch: f }), (e: unknown) => e instanceof CodeHostError && e.kind === "unsafe_input");
  assert.throws(() => createGitHubWriter(cfg({ apiUrl: "ftp://x" }), { fetch: f }), (e: unknown) => e instanceof CodeHostError && e.kind === "unsafe_input");
  assert.throws(() => createGitHubWriter(cfg({ apiUrl: "https://u:p@api.github.com" }), { fetch: f }), (e: unknown) => e instanceof CodeHostError && e.kind === "unsafe_input");
  createGitHubReader(cfg({ apiUrl: "http://127.0.0.1:9999" }), { fetch: f });
  createGitHubReader(cfg({ apiUrl: "https://ghe.example.com/api/v3/" }), { fetch: f });
});

test("a writer needs a token", () => {
  const f = createFakeFetch([]).fetch;
  assert.throws(() => createGitHubWriter(cfg({ token: null }), { fetch: f }), (e: unknown) => e instanceof CodeHostError && e.kind === "auth");
});

test("an API URL with a path prefix is kept (GitHub Enterprise)", async () => {
  const { reader, calls } = setup(
    [{ method: "GET", url: `https://ghe.example.com/api/v3/repos/acme/shop/branches/main`, body: { name: "main", protected: true, commit: { sha: BASE_SHA } } }],
    { config: { apiUrl: "https://ghe.example.com/api/v3/" } },
  );
  await reader.branchInfo({ owner: OWNER, repo: REPO, branch: "main" });
  assert.equal(calls.length, 1);
});

// ---------- surface ----------

test("the writer exposes only openDraftPullRequest and the reader no write method", () => {
  const { reader, writer } = setup([]);
  assert.deepEqual(Object.keys(writer), ["openDraftPullRequest"]);
  assert.deepEqual(Object.keys(reader).sort(), ["branchInfo", "commitExists", "compareFiles", "findPullByHead", "getCommit", "getRef"]);
});

test("every call is GET or POST and no path touches merge, reviews or labels", async () => {
  const { writer, reader, calls } = setup([
    ...writeRoutes({
      refs: { method: "POST", url: `${R}/git/refs`, status: 422, body: {} },
      extra: [{ method: "GET", url: `${R}/git/ref/heads/${BRANCH}`, body: { ref: `refs/heads/${BRANCH}`, object: { sha: COMMIT } } }],
    }),
    { method: "GET", url: `${R}/branches/main`, body: { name: "main", protected: true, commit: { sha: BASE_SHA } } },
    { method: "GET", url: `${R}/compare/${BASE_SHA}...main`, body: { files: [] } },
  ]);
  await writer.openDraftPullRequest(openInput());
  await reader.branchInfo({ owner: OWNER, repo: REPO, branch: "main" });
  await reader.compareFiles({ owner: OWNER, repo: REPO, base: BASE_SHA, head: "main" });
  assert.ok(calls.length >= 10);
  for (const c of calls) {
    assert.ok(c.method === "GET" || c.method === "POST", c.method);
    assert.ok(!/\/(merge|merges|reviews|labels)(\/|$|\?)/.test(new URL(c.url).pathname), c.url);
    assert.ok(c.url.startsWith(`${API}/repos/${OWNER}/${REPO}/`), c.url);
  }
});

test("requests carry the bearer token, the GitHub media type and the API version", async () => {
  const { reader, writer, calls } = setup([
    ...writeRoutes(),
    { method: "GET", url: `${R}/branches/main`, body: { name: "main", protected: true, commit: { sha: BASE_SHA } } },
  ]);
  await reader.branchInfo({ owner: OWNER, repo: REPO, branch: "main" });
  await writer.openDraftPullRequest(openInput());
  for (const c of calls) {
    assert.equal(c.headers["authorization"], `Bearer ${TOKEN}`);
    assert.equal(c.headers["accept"], "application/vnd.github+json");
    assert.equal(c.headers["x-github-api-version"], "2022-11-28");
    if (c.method === "POST") assert.equal(c.headers["content-type"], "application/json");
  }
});

test("a reader without a token sends no Authorization header", async () => {
  const { reader, calls } = setup(
    [{ method: "GET", url: `${R}/branches/main`, body: { name: "main", protected: true, commit: { sha: BASE_SHA } } }],
    { config: { token: null } },
  );
  await reader.branchInfo({ owner: OWNER, repo: REPO, branch: "main" });
  assert.equal(calls[0]!.headers["authorization"], undefined);
});

// ---------- failures ----------

const BRANCH_URL = `${R}/branches/main`;
const branchCall = (r: ReturnType<typeof setup>["reader"]) => r.branchInfo({ owner: OWNER, repo: REPO, branch: "main" });

for (const [status, kind, headers] of [
  [401, "auth", {}],
  [403, "forbidden", {}],
  [403, "rate_limited", { "x-ratelimit-remaining": "0" }],
  [404, "not_found", {}],
  [409, "conflict", {}],
  [422, "conflict", {}],
  [500, "unavailable", {}],
  [503, "unavailable", {}],
  [400, "bad_response", {}],
  [302, "bad_response", { location: "https://evil.example.com" }],
] as const) {
  test(`HTTP ${status}${Object.keys(headers).length ? " " + JSON.stringify(headers) : ""} maps to ${kind}`, async () => {
    const { reader } = setup([{ method: "GET", url: BRANCH_URL, status, headers, body: { message: `boom ${TOKEN}` } }]);
    const e = await rejectsKind(branchCall(reader), kind);
    assert.equal(e.status, status);
  });
}

test("429 maps to rate_limited with retry-after", async () => {
  const { reader } = setup([{ method: "GET", url: BRANCH_URL, status: 429, headers: { "retry-after": "42" }, body: {} }]);
  const e = await rejectsKind(branchCall(reader), "rate_limited");
  assert.equal(e.retryAfterSec, 42);
});

test("a timeout maps to timeout", async () => {
  const { reader } = setup([{ method: "GET", url: BRANCH_URL, delayMs: 500, body: {} }], { timeoutMs: 20 });
  await rejectsKind(branchCall(reader), "timeout");
});

test("a network failure maps to unavailable", async () => {
  const { reader } = setup([{ method: "GET", url: BRANCH_URL, error: "network" }]);
  await rejectsKind(branchCall(reader), "unavailable");
});

test("an oversized body maps to bad_response", async () => {
  const { reader } = setup([{ method: "GET", url: BRANCH_URL, body: "x".repeat(1_048_577) }]);
  await rejectsKind(branchCall(reader), "bad_response");
});

test("a malformed or wrongly shaped body maps to bad_response", async () => {
  const { reader } = setup([
    { method: "GET", url: BRANCH_URL, body: "{not json" },
    { method: "GET", url: `${R}/git/commits/${COMMIT}`, body: { sha: COMMIT, tree: "nope" } },
    { method: "GET", url: PULLS_LIST, body: { not: "a list" } },
  ]);
  await rejectsKind(branchCall(reader), "bad_response");
  await rejectsKind(reader.getCommit({ owner: OWNER, repo: REPO, sha: COMMIT }), "bad_response");
  await rejectsKind(reader.findPullByHead({ owner: OWNER, repo: REPO, branch: BRANCH }), "bad_response");
});

test("a write failure in the middle maps to a fixed kind and stops before the ref", async () => {
  const routes = writeRoutes();
  routes[4] = { method: "POST", url: `${R}/git/trees`, status: 500, body: { message: TOKEN } };
  const { writer, calls } = setup(routes);
  await rejectsKind(writer.openDraftPullRequest(openInput()), "unavailable");
  assert.ok(!calls.some((c) => pathOf(c.url).endsWith("/git/refs") || (c.method === "POST" && pathOf(c.url).endsWith("/pulls"))));
});

test("the token never appears in error messages or logger output", async () => {
  const seen: string[] = [];
  const statuses = [401, 403, 404, 422, 429, 500, 400];
  for (const status of statuses) {
    const { reader, lines } = setup([{ method: "GET", url: BRANCH_URL, status, headers: { "x-echo": TOKEN }, body: { message: `bad credentials ${TOKEN}` } }]);
    const e = await branchCall(reader).then(() => assert.fail("expected an error"), (x: unknown) => x);
    assert.ok(e instanceof CodeHostError);
    seen.push(e.message, String(e.stack), JSON.stringify(e), ...lines);
  }
  const t = setup([{ method: "GET", url: BRANCH_URL, delayMs: 200, body: {} }], { timeoutMs: 10 });
  const te = await rejectsKind(branchCall(t.reader), "timeout");
  seen.push(te.message, String(te.stack), ...t.lines);
  const w = setup(writeRoutes({ pulls: { method: "POST", url: `${R}/pulls`, status: 403, body: { message: TOKEN } } }));
  const we = await rejectsKind(w.writer.openDraftPullRequest(openInput()), "forbidden");
  seen.push(we.message, String(we.stack), ...w.lines);
  assert.ok(seen.length > 10);
  for (const s of seen) assert.ok(!s.includes(TOKEN) && !s.includes("github_pat_"), s);
});
