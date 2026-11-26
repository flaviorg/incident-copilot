// GitHub code host over REST (spec 009, decisions 15 and 20; AC-77, AC-78). It follows the notifier pattern, not the
// connector one: the shared HTTP client (GET and POST only, 10 s timeout, 1 MiB cap, `redirect: "error"`) over an
// injected `fetch`. Reader and writer are separate factories: the fixer graph gets only a reader; the writer can only
// open a draft pull request. Owner, repository, SHAs, branches and paths are validated and checked against the allowlist
// before any request. Errors are CodeHostError kinds with no body, header or token, and nothing here logs a URL,
// header or body.
import * as z from "zod";
import { createHttpClient, type HttpClient, type HttpResponse } from "../../connectors/shared/http.ts";
import type {
  BranchInfo,
  CodeHostReader,
  CodeHostWriter,
  CommitInfo,
  DraftPullRequestInput,
  GitRefInfo,
  PullRequestInfo,
  RepoRef,
} from "../../domain/code-fix/ports.ts";
import type { Logger } from "../../infra/logger.ts";
import { CodeHostError, errorFromStatus, errorFromTransport } from "./errors.ts";
import {
  assertBranch,
  assertFilePath,
  assertFixBranch,
  assertName,
  assertRevision,
  assertSha,
  branchOfRef,
  githubPaths as P,
} from "./urls.ts";

/** Unverified, documented in docs/code-fixer.md. */
export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_TIMEOUT_MS = 10_000;
export const GITHUB_MAX_RESPONSE_BYTES = 1_048_576;
/** The compare endpoint lists at most 300 files (unverified); a list this long may be truncated, so it fails closed. */
export const COMPARE_MAX_FILES = 300;
const MAX_FILES = 20;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type GitHubCodeHostConfig = {
  /** From `h.url()`: https, loopback http only in tests. Checked again here. */
  apiUrl: string;
  /** Fine-grained PAT from `h.secret()`; null reads public repositories only and cannot build a writer. */
  token: string | null;
  /** Allowlisted `owner/name` entries (case-insensitive, as GitHub names are). */
  repositories: readonly string[];
};

export type GitHubCodeHostDeps = {
  fetch: typeof fetch;
  logger?: Logger;
  /** Overrides the 10 s timeout (tests). */
  timeoutMs?: number;
};

export type DraftPullRequestResult = PullRequestInfo & {
  /** The commit the branch points at; for a pull request that already existed, its head SHA. */
  commitSha: string | null;
  /** Our tree; null when an existing pull request was returned without building one. */
  treeSha: string | null;
};

export interface GitHubReader extends CodeHostReader {}

/** Only `openDraftPullRequest`: no merge, review, label, PUT, PATCH or DELETE. */
export interface GitHubWriter extends CodeHostWriter {
  openDraftPullRequest(input: DraftPullRequestInput): Promise<DraftPullRequestResult>;
}

// ---------- response shapes (only the fields we read) ----------

const Sha = z.string().regex(/^[0-9a-fA-F]{40}$/).transform((s) => s.toLowerCase());
const ShaObject = z.object({ sha: Sha });
const CommitBody = z.object({ sha: Sha, tree: ShaObject, parents: z.array(ShaObject) });
const BranchBody = z.object({ name: z.string().max(255), protected: z.boolean(), commit: ShaObject });
const CompareBody = z.object({
  files: z.array(z.object({ filename: z.string().max(4096), previous_filename: z.string().max(4096).optional() })).optional(),
});
const PullBody = z.object({
  number: z.number().int().positive(),
  html_url: z.string().max(2000).regex(/^https?:\/\//),
  draft: z.boolean().optional(),
  head: z.object({ ref: z.string().max(255), sha: Sha }),
});
const PullList = z.array(PullBody).max(100);
const RefBody = z.object({ ref: z.string().max(255), object: ShaObject });

type Pull = z.infer<typeof PullBody>;

// ---------- core ----------

function checkApiUrl(apiUrl: string): string {
  let u: URL;
  try {
    u = new URL(apiUrl);
  } catch {
    throw new CodeHostError("unsafe_input");
  }
  const loopbackHttp = u.protocol === "http:" && LOOPBACK.has(u.hostname);
  if ((u.protocol !== "https:" && !loopbackHttp) || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") {
    throw new CodeHostError("unsafe_input");
  }
  return u.href.replace(/\/+$/, "");
}

type Core = {
  repo(r: RepoRef): { owner: string; repo: string };
  get(op: string, path: string, ok?: readonly number[]): Promise<HttpResponse>;
  post(op: string, path: string, body: unknown, ok?: readonly number[]): Promise<HttpResponse>;
  parse<T>(res: HttpResponse, schema: z.ZodType<T>): T;
};

function createCore(cfg: GitHubCodeHostConfig, deps: GitHubCodeHostDeps): Core {
  const base = checkApiUrl(cfg.apiUrl);
  const allowed = new Set(cfg.repositories.map((x) => x.toLowerCase()));
  const http: HttpClient = createHttpClient({
    fetch: deps.fetch,
    timeoutMs: deps.timeoutMs ?? GITHUB_TIMEOUT_MS,
    maxResponseBytes: GITHUB_MAX_RESPONSE_BYTES,
  });
  const headers = (json: boolean): Record<string, string> => ({
    accept: "application/vnd.github+json",
    "x-github-api-version": GITHUB_API_VERSION,
    ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
    ...(json ? { "content-type": "application/json" } : {}),
  });

  const send = async (op: string, method: "GET" | "POST", path: string, body: unknown, ok: readonly number[]): Promise<HttpResponse> => {
    let res: HttpResponse;
    try {
      res = await http.request({
        method,
        url: base + path,
        headers: headers(method === "POST"),
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      const err = errorFromTransport(e);
      deps.logger?.warn("codehost request failed", { op, kind: err.kind, status: null });
      throw err;
    }
    deps.logger?.debug("codehost request", { op, method, status: res.status });
    if ((res.status >= 200 && res.status < 300) || ok.includes(res.status)) return res;
    const err = errorFromStatus(res.status, res.headers);
    deps.logger?.warn("codehost request failed", { op, kind: err.kind, status: res.status });
    throw err;
  };

  return {
    repo(r) {
      const owner = assertName(r.owner);
      const repo = assertName(r.repo);
      if (!allowed.has(`${owner}/${repo}`.toLowerCase())) throw new CodeHostError("unsafe_input");
      return { owner, repo };
    },
    get: (op, path, ok = []) => send(op, "GET", path, undefined, ok),
    post: (op, path, body, ok = []) => send(op, "POST", path, body, ok),
    parse(res, schema) {
      let raw: unknown;
      try {
        raw = JSON.parse(res.text);
      } catch {
        throw new CodeHostError("bad_response", { status: res.status });
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new CodeHostError("bad_response", { status: res.status });
      return parsed.data;
    },
  };
}

function toPullInfo(p: Pull): PullRequestInfo {
  return { number: p.number, url: p.html_url, branch: p.head.ref, draft: p.draft ?? false };
}

function readerOps(core: Core) {
  const getCommit = async (r: RepoRef & { sha: string }): Promise<CommitInfo> => {
    const { owner, repo } = core.repo(r);
    const sha = assertSha(r.sha);
    const c = core.parse(await core.get("getCommit", P.gitCommit(owner, repo, sha)), CommitBody);
    return { sha: c.sha, tree: c.tree.sha, parents: c.parents.map((x) => x.sha) };
  };

  const findPull = async (r: RepoRef & { branch: string }): Promise<Pull | null> => {
    const { owner, repo } = core.repo(r);
    const branch = assertBranch(r.branch);
    const list = core.parse(await core.get("findPullByHead", P.pullsByHead(owner, repo, branch)), PullList);
    return list.find((p) => p.head.ref === branch) ?? null;
  };

  const reader: GitHubReader = {
    async commitExists(r) {
      const { owner, repo } = core.repo(r);
      const sha = assertSha(r.sha);
      const res = await core.get("commitExists", P.gitCommit(owner, repo, sha), [404]);
      if (res.status === 404) return false;
      return core.parse(res, CommitBody).sha === sha;
    },
    async branchInfo(r): Promise<BranchInfo> {
      const { owner, repo } = core.repo(r);
      const branch = assertBranch(r.branch);
      const b = core.parse(await core.get("branchInfo", P.branch(owner, repo, branch)), BranchBody);
      return { name: b.name, protected: b.protected, headSha: b.commit.sha };
    },
    async compareFiles(r) {
      const { owner, repo } = core.repo(r);
      const base = assertRevision(r.base);
      const head = assertRevision(r.head);
      const c = core.parse(await core.get("compareFiles", P.compare(owner, repo, base, head)), CompareBody);
      const files = c.files ?? [];
      if (files.length >= COMPARE_MAX_FILES) throw new CodeHostError("bad_response");
      const out: string[] = [];
      for (const f of files) {
        out.push(f.filename);
        if (f.previous_filename !== undefined && f.previous_filename !== f.filename) out.push(f.previous_filename);
      }
      return out;
    },
    async findPullByHead(r) {
      const p = await findPull(r);
      return p ? toPullInfo(p) : null;
    },
    async getRef(r): Promise<GitRefInfo | null> {
      const { owner, repo } = core.repo(r);
      const branch = branchOfRef(r.ref);
      const res = await core.get("getRef", P.gitBranchRef(owner, repo, branch), [404]);
      if (res.status === 404) return null;
      const ref = core.parse(res, RefBody);
      if (ref.ref !== `refs/heads/${branch}`) return null;
      return { ref: ref.ref, sha: ref.object.sha };
    },
    getCommit,
  };
  return { reader, findPull };
}

export function createGitHubReader(cfg: GitHubCodeHostConfig, deps: GitHubCodeHostDeps): GitHubReader {
  return readerOps(createCore(cfg, deps)).reader;
}

export function createGitHubWriter(cfg: GitHubCodeHostConfig, deps: GitHubCodeHostDeps): GitHubWriter {
  if (typeof cfg.token !== "string" || cfg.token.length === 0) throw new CodeHostError("auth");
  const core = createCore(cfg, deps);
  const { reader, findPull } = readerOps(core);
  const conflict = () => new CodeHostError("conflict");

  const validate = (input: DraftPullRequestInput) => {
    const { owner, repo } = core.repo(input);
    const base = assertBranch(input.base);
    const baseCommitSha = assertSha(input.baseCommitSha);
    const branch = assertFixBranch(input.branch);
    if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > MAX_FILES) throw new CodeHostError("unsafe_input");
    const seen = new Set<string>();
    for (const f of input.files) {
      assertFilePath(f.path);
      if (typeof f.content !== "string" || seen.has(f.path)) throw new CodeHostError("unsafe_input");
      seen.add(f.path);
    }
    for (const s of [input.title, input.commitMessage, input.author.name, input.author.email, input.author.date]) {
      if (typeof s !== "string" || s.trim() === "") throw new CodeHostError("unsafe_input");
    }
    if (typeof input.body !== "string") throw new CodeHostError("unsafe_input");
    return { owner, repo, base, baseCommitSha, branch };
  };

  return {
    async openDraftPullRequest(input) {
      const { owner, repo, base, baseCommitSha, branch } = validate(input);

      // 1. A pull request from our branch already exists: record and return it, with no write.
      const existing = await findPull({ owner, repo, branch });
      if (existing) return { ...toPullInfo(existing), commitSha: existing.head.sha, treeSha: null };

      // 2. Blobs, then a tree on the base commit's tree (regular files only), then one commit on the base commit.
      const baseCommit = await reader.getCommit({ owner, repo, sha: baseCommitSha });
      const entries: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
      for (const f of input.files) {
        const blob = core.parse(
          await core.post("createBlob", P.gitBlobs(owner, repo), { content: Buffer.from(f.content, "utf8").toString("base64"), encoding: "base64" }),
          ShaObject,
        );
        entries.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
      }
      const tree = core.parse(await core.post("createTree", P.gitTrees(owner, repo), { base_tree: baseCommit.tree, tree: entries }), ShaObject).sha;
      const signature = { name: input.author.name, email: input.author.email, date: input.author.date };
      const commit = core.parse(
        await core.post("createCommit", P.gitCommits(owner, repo), {
          message: input.commitMessage,
          tree,
          parents: [baseCommitSha],
          author: signature,
          committer: signature,
        }),
        CommitBody,
      );
      if (commit.tree.sha !== tree || commit.parents.length !== 1 || commit.parents[0]!.sha !== baseCommitSha) {
        throw new CodeHostError("bad_response");
      }
      let commitSha = commit.sha;

      // 3. Persist the commit before the ref exists, so a retry reuses it.
      await input.onCommit?.({ sha: commitSha, tree });

      // 4. The branch. A 422 means it exists: accept our commit, or one with our tree on parents [base].
      const refRes = await core.post("createRef", P.gitRefs(owner, repo), { ref: `refs/heads/${branch}`, sha: commitSha }, [422]);
      if (refRes.status === 422) {
        const ref = await reader.getRef({ owner, repo, ref: `refs/heads/${branch}` });
        if (!ref) throw conflict();
        if (ref.sha !== commitSha) {
          const there = await reader.getCommit({ owner, repo, sha: ref.sha });
          if (there.tree !== tree || there.parents.length !== 1 || there.parents[0] !== baseCommitSha) throw conflict();
          commitSha = there.sha;
        }
      }

      // 5. The draft pull request. A 422 means it may already exist: look it up by head.
      const prRes = await core.post(
        "createPull",
        P.pulls(owner, repo),
        { title: input.title, head: branch, base, body: input.body, draft: true, maintainer_can_modify: false },
        [422],
      );
      if (prRes.status === 422) {
        const found = await findPull({ owner, repo, branch });
        if (!found) throw conflict();
        return { ...toPullInfo(found), commitSha, treeSha: tree };
      }
      return { ...toPullInfo(core.parse(prRes, PullBody)), commitSha, treeSha: tree };
    },
  };
}
