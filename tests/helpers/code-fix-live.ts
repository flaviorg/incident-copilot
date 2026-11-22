// Offline end-to-end harness of the code fixer (spec 009, "Demonstrable milestone"): a Sentry webhook opens a live
// incident on the tiny-cart fixture repository; the real git workspace (file:// remote), the real process sandbox
// (best_effort, with the no-network setup as a test-only import) and the scripted fake run the attempt. Sentry and
// GitHub answer through one injected fetch; nothing reaches the network. Every key-shaped value is built at run time.
import { createHash, createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import * as z from "zod";
import { sentryConnector } from "../../src/connectors/sentry/index.ts";
import { ProcessSandboxRunner } from "../../src/infra/code-fix/process-sandbox.ts";
import { GitCliWorkspace } from "../../src/infra/code-fix/git-workspace.ts";
import { projectPath } from "../../src/infra/paths.ts";
import type { GitWorkspacePort, Workspace } from "../../src/domain/code-fix/ports.ts";
import { buildServer } from "../../src/http/server.ts";
import { defineNotifier } from "../../src/notifiers/types.ts";
import type { NotificationMessage, NotifierDefinition } from "../../src/notifiers/types.ts";
import { createTestContainer } from "./container.ts";
import type { TestContainer } from "./container.ts";
import { createFakeFetch } from "./fake-fetch.ts";
import type { FakeCall, FakeRoute } from "./fake-fetch.ts";
import { createFixtureRepo } from "./fixture-repo.ts";
import type { FixtureFiles, FixtureRepo } from "./fixture-repo.ts";
import { liveCopilot } from "./live.ts";

export const LIVE_FIX_FIXTURE = "tests/fixtures/llm/live-sentry-fix.json";
export const SERVICE = "tiny-cart";
export const ORG = "acme";
export const ISSUE_ID = "5150042";
export const ANCHOR_FILE = "src/cart.js";
/** `cart.items.length` in tests/fixtures/repos/tiny-cart/src/cart.js. */
export const ANCHOR_LINE = 14;
export const NEW_TEST = "tests/cart-empty.test.js";
export const PUBLIC_URL = "https://copilot.example.com";
export const EXCEPTION_VALUE = "Cannot read properties of undefined (reading 'length')";
const SENTRY_API = "https://sentry.io/api/0";
const GITHUB_API = "https://api.github.com";
const NO_NETWORK = projectPath("tests/setup/no-network.ts");

/** Repositories of the fixture turns: each case has its own, so the fake's `{ repo, attempt }` keys pick its script. */
export const REPOS = {
  fix: "acme/tiny-cart",
  hostile: "acme/tiny-cart-hostile",
  noRepro: "acme/tiny-cart-norepro",
} as const;

export type LiveSecrets = { sentryClientSecret: string; sentryToken: string; githubToken: string; openrouterKey: string };

/** Key-shaped values built at run time, so none sits in the tree. */
export function liveSecrets(): LiveSecrets {
  return {
    sentryClientSecret: "sentry-cs-" + "q7".repeat(16),
    sentryToken: "sntrys_" + "K3".repeat(20),
    githubToken: "github_pat_" + "W5".repeat(35),
    openrouterKey: "sk-or-v1-" + "e".repeat(40),
  };
}

// ---------- copilot.yaml ----------

export type NotifierSpec = { id: string; type: string; events?: readonly string[] };

export function liveYaml(o: { repo: string; mode: "shadow" | "draft_pr"; codeFix: boolean; notifiers: readonly NotifierSpec[] }): string {
  const notifiers = o.notifiers.length === 0
    ? ""
    : "notifiers:\n" + o.notifiers.map((n) => `  - id: ${n.id}\n    type: ${n.type}\n` + (n.events ? `    events: [${n.events.join(", ")}]\n` : "")).join("");
  const codeFix = !o.codeFix ? "" : `
codeFix:
  enabled: true
  mode: ${o.mode}
  sandbox: { network: best_effort }
  github:
    apiUrl: ${GITHUB_API}
    token: "\${GITHUB_FIX_TOKEN}"
  repositories:
    - repo: ${o.repo}
      service: ${SERVICE}
      connector: sentry
      baseBranch: main
      pathPrefixes: ["/app/"]
      sourceGlobs: ["src/**/*.js"]
      testGlobs: ["tests/**/*.test.js"]
      testFiles: ["tests/**/*.test.js"]
`;
  return `
version: 1
mode: shadow
publicUrl: ${PUBLIC_URL}/
services:
  - name: ${SERVICE}
    aliases: { sentry: [${SERVICE}] }
connectors:
  - id: sentry
    type: sentry
    ingest: { clientSecret: "\${SENTRY_CLIENT_SECRET}", resources: [event_alert] }
    query: { organization: ${ORG}, token: "\${SENTRY_TOKEN}" }
${notifiers}${codeFix}`;
}

// ---------- Sentry ----------

export const ALERT_AT = "2026-10-04T09:41:30Z";

/** The signed event_alert webhook of the tiny-cart issue. */
export function sentryWebhook(secret: string): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify({
    action: "triggered",
    installation: { uuid: "b1c2d3e4-0d4e-4f5a-9b6c-7d8e9f0a1b2c" },
    data: {
      event: {
        event_id: "0a1b2c3d4e5f60718293a4b5c6d7e8f9",
        issue_id: ISSUE_ID,
        web_url: `https://acme.sentry.io/issues/${ISSUE_ID}/events/0a1b2c3d4e5f60718293a4b5c6d7e8f9/`,
        title: `TypeError: ${EXCEPTION_VALUE}`,
        platform: "node",
        level: "fatal",
        project: SERVICE,
        datetime: ALERT_AT,
      },
      triggered_rule: "Checkout errors after deploy",
    },
    actor: { type: "application", id: "sentry", name: "Sentry" },
  });
  return {
    body,
    headers: {
      "content-type": "application/json",
      "sentry-hook-resource": "event_alert",
      "sentry-hook-signature": createHmac("sha256", secret).update(body, "utf8").digest("hex"),
    },
  };
}

/** Issue list, project, releases, issue detail, latest event and release detail of the tiny-cart project. */
export function sentryRoutes(o: { repo: string; releaseSha: string; exceptionValue: string }): FakeRoute[] {
  const issue = {
    id: ISSUE_ID,
    title: `TypeError: ${EXCEPTION_VALUE}`,
    culprit: "cartTotal(src/cart)",
    permalink: `https://acme.sentry.io/issues/${ISSUE_ID}/`,
    level: "fatal",
    status: "unresolved",
    count: "212",
    userCount: 64,
    firstSeen: "2026-10-04T09:41:30.000Z",
    lastSeen: "2026-10-04T09:52:10.000Z",
    firstRelease: { version: o.releaseSha },
    lastRelease: { version: o.releaseSha },
    project: { id: "6600001", name: "Tiny Cart", slug: SERVICE },
  };
  const release = {
    version: o.releaseSha,
    dateCreated: "2026-10-04T09:30:00.000Z",
    dateReleased: "2026-10-04T09:35:00.000Z",
    lastDeploy: { id: "901", environment: "production", dateFinished: "2026-10-04T09:38:00.000Z" },
    lastCommit: { id: o.releaseSha, message: "release", repository: { id: "42", name: o.repo } },
    projects: [{ id: "6600001", name: "Tiny Cart", slug: SERVICE }],
  };
  const event = {
    id: "0a1b2c3d4e5f60718293a4b5c6d7e8f9",
    groupID: ISSUE_ID,
    title: `TypeError: ${EXCEPTION_VALUE}`,
    platform: "node",
    tags: [{ key: "environment", value: "production" }, { key: "release", value: o.releaseSha }],
    entries: [{
      type: "exception",
      data: {
        values: [{
          type: "TypeError",
          value: o.exceptionValue,
          stacktrace: {
            frames: [
              { filename: "node:internal/process/task_queues", lineno: 95, colno: 5, function: "processTicksAndRejections", in_app: false },
              { abs_path: "/app/src/cart.js", lineno: ANCHOR_LINE, colno: 33, function: "cartTotal", in_app: true, context_line: "  for (let i = 0; i < cart.items.length; i++) {" },
            ],
          },
        }],
      },
    }],
  };
  const org = `${SENTRY_API}/organizations/${ORG}`;
  return [
    { method: "GET", url: new RegExp(`^${esc(`${SENTRY_API}/projects/${ORG}/${SERVICE}/issues/?`)}`), body: [issue] },
    { method: "GET", url: `${SENTRY_API}/projects/${ORG}/${SERVICE}/`, body: { id: "6600001", slug: SERVICE, name: "Tiny Cart" } },
    { method: "GET", url: new RegExp(`^${esc(`${org}/releases/?`)}`), body: [release] },
    { method: "GET", url: `${org}/issues/${ISSUE_ID}/`, body: issue },
    { method: "GET", url: `${org}/issues/${ISSUE_ID}/events/latest/`, body: event },
    { method: "GET", url: `${org}/releases/${o.releaseSha}/`, body: release },
  ];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------- GitHub ----------

export type GhCall = { method: string; path: string; url: string; body: string | null; authorization: string | null };

/** A stateful GitHub REST fake for one repository (the T10 fake, deterministic SHAs, 422 on an existing ref). */
export function createFakeGitHub(o: { repo: string; headSha: string }) {
  const repoPath = `/repos/${o.repo}`;
  const [owner] = o.repo.split("/") as [string, string];
  const calls: GhCall[] = [];
  const baseTree = "c".repeat(40);
  const commits = new Map<string, { tree: string; parents: string[] }>([[o.headSha, { tree: baseTree, parents: [] }]]);
  const refs = new Map<string, string>();
  const pulls: { number: number; html_url: string; draft: boolean; head: { ref: string; sha: string }; body: string; title: string }[] = [];
  const h = (s: string) => createHash("sha1").update(s).digest("hex");
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchFn = async (url: URL, init: RequestInit): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    const raw = typeof init.body === "string" ? init.body : null;
    const auth = new Headers(init.headers).get("authorization");
    calls.push({ method, path: url.pathname, url: url.href, body: raw, authorization: auth });
    if (!url.pathname.startsWith(repoPath + "/")) return json(404, { message: "Not Found" });
    const p = url.pathname.slice(repoPath.length);
    const body = raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
    if (method === "GET" && p === "/branches/main") return json(200, { name: "main", protected: true, commit: { sha: o.headSha } });
    if (method === "GET" && p === `/compare/${o.headSha}...main`) return json(200, { files: [] });
    if (method === "GET" && p === "/pulls") {
      const head = url.searchParams.get("head") ?? "";
      return json(200, pulls.filter((x) => `${owner}:${x.head.ref}` === head));
    }
    if (method === "GET" && p.startsWith("/git/commits/")) {
      const sha = p.slice("/git/commits/".length);
      const c = commits.get(sha);
      return c ? json(200, { sha, tree: { sha: c.tree }, parents: c.parents.map((x) => ({ sha: x })) }) : json(404, { message: "Not Found" });
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
      const head = String(body!.head);
      const pr = {
        number: 7, html_url: `https://github.com/${o.repo}/pull/7`, draft: body!.draft === true, head: { ref: head, sha: refs.get(head)! },
        body: String(body!.body), title: String(body!.title),
      };
      pulls.push(pr);
      return json(201, pr);
    }
    return json(404, { message: "Not Found" });
  };
  return { fetch: fetchFn, calls, refs, pulls };
}

// ---------- notifiers ----------

export type CapturingNotifier = { definition: NotifierDefinition<unknown>; messages: NotificationMessage[] };

/** A test notifier of its own type, so two of them in one config keep separate message lists. */
export function capturingNotifier(type: string): CapturingNotifier {
  const messages: NotificationMessage[] = [];
  const definition = defineNotifier({
    type,
    configSchema: () => z.strictObject({}),
    create: (_c, d) => ({
      id: d.id,
      type,
      send: async (m) => {
        messages.push(structuredClone(m));
        return { ok: true };
      },
    }),
  });
  return { definition, messages };
}

// ---------- workspace spy ----------

export type WorkspaceRecord = { root: string; anchorAtDispose: string | null; testAtDispose: string | null; writes: string[]; removed: boolean };

/** The real workspace, recording what was written and the anchor file's text right before dispose. */
export function spyWorkspace(inner: GitWorkspacePort): { port: GitWorkspacePort; records: WorkspaceRecord[] } {
  const records: WorkspaceRecord[] = [];
  const port: GitWorkspacePort = {
    async prepare(input) {
      const ws = await inner.prepare(input);
      const rec: WorkspaceRecord = { root: ws.root, anchorAtDispose: null, testAtDispose: null, writes: [], removed: false };
      records.push(rec);
      const wrapped: Workspace = {
        root: ws.root,
        repoDir: ws.repoDir,
        tmpDir: ws.tmpDir,
        kitDir: ws.kitDir,
        baseHead: ws.baseHead,
        readAt: (sha, path) => ws.readAt(sha, path),
        modeAt: (sha, path) => ws.modeAt(sha, path),
        sameAt: (a, b, path) => ws.sameAt(a, b, path),
        readFile: (path) => ws.readFile(path),
        writeFile: async (path, content) => {
          rec.writes.push(path);
          await ws.writeFile(path, content);
        },
        listFiles: (globs) => ws.listFiles(globs),
        stagedDiff: () => ws.stagedDiff(),
        async dispose() {
          rec.anchorAtDispose = await ws.readFile(ANCHOR_FILE);
          rec.testAtDispose = await ws.readFile(NEW_TEST);
          await ws.dispose();
          rec.removed = !existsSync(ws.root);
        },
      };
      return wrapped;
    },
  };
  return { port, records };
}

// ---------- the harness ----------

export type LiveFixHarness = {
  c: TestContainer;
  app: ReturnType<typeof buildServer>;
  repo: FixtureRepo;
  secrets: LiveSecrets;
  gh: ReturnType<typeof createFakeGitHub>;
  sentryCalls: FakeCall[];
  workspaces: WorkspaceRecord[];
  /** Notifier with events [code_fix_ready, code_fix_pr_opened]; `team` has the default events. */
  fixNotifier: CapturingNotifier;
  teamNotifier: CapturingNotifier;
  /** Every response body this harness sent through `app.inject`. */
  responses: string[];
  /** Posts the signed webhook and waits for the incident and the attempt. */
  ingest(): Promise<{ status: number; body: string; incidentId: string }>;
  inject(o: { method: "GET" | "POST"; url: string; payload?: unknown; headers?: Record<string, string> }): Promise<{ statusCode: number; body: string; json(): any }>;
  close(): Promise<void>;
};

export type LiveFixOptions = {
  repo?: string;
  mode?: "shadow" | "draft_pr";
  codeFix?: boolean;
  /** Files planted in the fixture repository before the release commit. */
  overrides?: FixtureFiles;
  /** The latest event's exception value; a function receives the run-time secrets (to plant one). */
  exceptionValue?: string | ((s: LiveSecrets) => string);
  /** The sandbox self-test outcome (default ok). */
  sandboxOk?: boolean;
};

export async function liveFixHarness(o: LiveFixOptions = {}): Promise<LiveFixHarness> {
  const repoName = o.repo ?? REPOS.fix;
  const secrets = liveSecrets();
  const repo = await createFixtureRepo("tiny-cart", o.overrides ? { overrides: o.overrides } : {});
  function setup() {
    const exceptionValue = typeof o.exceptionValue === "function" ? o.exceptionValue(secrets) : (o.exceptionValue ?? EXCEPTION_VALUE);
    const sentry = createFakeFetch(sentryRoutes({ repo: repoName, releaseSha: repo.releaseSha, exceptionValue }));
    const gh = createFakeGitHub({ repo: repoName, headSha: repo.headSha });
    const doFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.origin === GITHUB_API) return gh.fetch(url, init);
      return sentry.fetch(input, init);
    }) as typeof fetch;

    const fixNotifier = capturingNotifier("fix-capture");
    const teamNotifier = capturingNotifier("team-capture");
    const env = {
      SENTRY_CLIENT_SECRET: secrets.sentryClientSecret, SENTRY_TOKEN: secrets.sentryToken, GITHUB_FIX_TOKEN: secrets.githubToken,
    };
    const defs = [sentryConnector];
    const notifierDefs = [fixNotifier.definition, teamNotifier.definition];
    const copilot = liveCopilot(
      liveYaml({
        repo: repoName, mode: o.mode ?? "shadow", codeFix: o.codeFix ?? true,
        notifiers: [{ id: "fixes", type: "fix-capture", events: ["code_fix_ready", "code_fix_pr_opened"] }, { id: "team", type: "team-capture" }],
      }),
      { env, connectors: defs, notifiers: notifierDefs },
    );
    const allSecrets = [secrets.sentryClientSecret, secrets.sentryToken, secrets.githubToken, secrets.openrouterKey];
    const spy = spyWorkspace(new GitCliWorkspace({ allowFileProtocol: true, remoteUrlFor: () => repo.bareUrl, secrets: allSecrets }));
    const c = createTestContainer({
      env: { OPENROUTER_API_KEY: secrets.openrouterKey },
      copilot,
      connectorDefinitions: defs,
      notifierDefinitions: notifierDefs,
      fixture: LIVE_FIX_FIXTURE,
      fetch: doFetch,
      sleep: async () => {},
      codeFixPorts: {
        workspace: spy.port,
        sandbox: (ws) => new ProcessSandboxRunner({
          attemptDir: ws.root, network: "best_effort", maxOutputBytes: 65_536, secrets: allSecrets, extraImports: [NO_NETWORK],
        }),
        selfTest: async () => (o.sandboxOk === false ? { ok: false, failed: ["network"] } : { ok: true }),
      },
    });
    return { c, gh, sentry, spy, fixNotifier, teamNotifier };
  }
  // Everything after the repository is created: a setup failure must not leave the temporary repository behind.
  let built: ReturnType<typeof setup>;
  try {
    built = setup();
  } catch (e) {
    await repo.cleanup();
    throw e;
  }
  const { c, gh, sentry, spy, fixNotifier, teamNotifier } = built;
  const app = buildServer(c);
  const responses: string[] = [];
  const inject: LiveFixHarness["inject"] = async (r) => {
    const res = await app.inject({ method: r.method, url: r.url, headers: r.headers ?? {}, ...(r.payload !== undefined ? { payload: r.payload as object } : {}) });
    responses.push(res.body);
    return res;
  };
  return {
    c, app, repo, secrets, gh, sentryCalls: sentry.calls, workspaces: spy.records, fixNotifier, teamNotifier, responses, inject,
    async ingest() {
      const hook = sentryWebhook(secrets.sentryClientSecret);
      const res = await app.inject({ method: "POST", url: "/ingest/sentry", payload: hook.body, headers: hook.headers });
      responses.push(res.body);
      await c.alertQueue.idle();
      await c.codeFix?.idle();
      const incidentId = c.store.listIncidents({ limit: 1 })[0]?.id ?? "";
      return { status: res.statusCode, body: res.body, incidentId };
    },
    async close() {
      c.close();
      await repo.cleanup();
    },
  };
}

// ---------- untrusted delimiters ----------

const DELIMITER = /<<<(UNTRUSTED [^>\n]*|END OF [A-Z ]+)>>>/g;

/** Offsets of `needle` in `text` that are not inside an untrusted block (the last delimiter before it is not an opener). */
export function outsideUntrusted(text: string, needle: string): number[] {
  const marks = Array.from(text.matchAll(DELIMITER), (m) => ({ at: m.index, open: m[1]!.startsWith("UNTRUSTED") }));
  const out: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    const before = marks.filter((m) => m.at < i).at(-1);
    if (!before || !before.open) out.push(i);
  }
  return out;
}
