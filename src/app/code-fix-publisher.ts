// The code-fix publisher (spec 009, decisions 3, 13, 15, 16 and 21; AC-77, AC-79, AC-81, AC-82). No LLM. It is the only
// holder of a CodeHostWriter and runs only for an `approved` or `publishing` attempt. It sets `publishing` before the
// first request, then checks, in order: the stored patch and post-images against the approved hash, the catalog tier,
// the base branch protection and the base staleness, and only then asks the writer for the draft pull request (which
// reuses its own branch or pull request on a retry). The commit is persisted through `onCommit` before the ref exists.
// Every text that leaves goes through `redactSecrets`. `publish` never throws.
//
// Code-host errors (decision 16, AC-81, AC-82). A transient kind (timeout, network, 5xx, rate limit, malformed response)
// may hide a write that succeeded, such as a POST /pulls whose response was lost, so it never ends the attempt at once:
// the run is retried in process up to `retry.maxTries` times with exponential backoff (a rate limit waits at least its
// `retry-after`), and every retry starts again from the checks and `findPullByHead`, so a pull request created by a lost
// response is recorded, never duplicated. When the retries run out:
// - with no commit persisted, no ref or pull request can exist, so it ends publish_failed/codehost_error and releases
//   the key (decision 16 as written);
// - with a commit persisted, a branch and maybe a pull request may exist, so the attempt stays `publishing` with the key
//   held, and `CodeFixService.recover()` retries it idempotently on the next start.
// Deviation from decision 16 as first written (it listed `codehost_error` as always releasing the key; the spec now
// carries this rule): a codehost_error that ends an
// attempt with a commit persisted (a definitive kind such as auth or forbidden) keeps the key, because the branch, or a
// pull request from an earlier lost response, may already exist and AC-82 forbids a second one for the group.
// Definitive outcomes (patch_mismatch, catalog_refused, base_unprotected, stale_base, ref_conflict and the 4xx kinds)
// end the attempt with no retry. Any other throw (a crash) leaves it `publishing` for `recover()`.
import { setTimeout as delay } from "node:timers/promises";
import type { CodeFixAttempt, CodeFixReason } from "../contracts/index.ts";
import { classifyAction } from "../domain/autonomy/catalog.ts";
import { canonicalPatchPayload } from "../domain/code-fix/patch-payload.ts";
import { renderPullRequestBody, renderPullRequestTitle } from "../domain/code-fix/pr-body.ts";
import type { CodeHostErrorKind, CodeHostReader, CodeHostWriter, PullRequestInfo } from "../domain/code-fix/ports.ts";
import { isTransientReason } from "../domain/code-fix/reasons.ts";
import type { SqliteCodeFixStore } from "../infra/db/code-fix-store.ts";
import type { SqliteIncidentStore } from "../infra/db/incident-store.ts";
import type { CodeFixConfig } from "../infra/copilot-config/schema.ts";
import type { Clock } from "../infra/clock.ts";
import type { Logger } from "../infra/logger.ts";
import { redactSecrets } from "../infra/redact.ts";
import { sha256Hex } from "./code-fix-service.ts";

const ACTOR = "system:code-fix-publisher";
export const DRAFT_PR_ACTION = "open_draft_pull_request";
export const FIX_BRANCH_PREFIX = "incident-copilot/fix-";

export type CodeFixPublisherDeps = {
  store: Pick<SqliteIncidentStore, "appendAudit">;
  fixes: SqliteCodeFixStore;
  config: Pick<CodeFixConfig, "repositories" | "commitAuthor">;
  reader: Pick<CodeHostReader, "branchInfo" | "compareFiles">;
  writer: CodeHostWriter;
  clock: Clock;
  logger: Logger;
  secrets: readonly string[];
  /** copilot.yaml `publicUrl`, for the incident link in the pull request body. */
  publicUrl: string | null;
  /** The catalog classifier; tests may replace it. Defaults to `classifyAction`. */
  classify?: typeof classifyAction;
  /** The bounded in-process retry of transient code-host errors. Defaults to `PUBLISH_RETRY`. */
  retry?: PublishRetryPolicy;
  /** Waits between retries; tests replace it. Defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
};

export type PublishRetryPolicy = { maxTries: number; baseDelayMs: number; maxDelayMs: number };

/** Three tries, waiting 1 s then 2 s (a rate limit waits its retry-after, at most 60 s). */
export const PUBLISH_RETRY: PublishRetryPolicy = Object.freeze({ maxTries: 3, baseDelayMs: 1000, maxDelayMs: 60_000 });

/** Kinds whose request may have reached the code host, or that clear by themselves: retried, never final on their own. */
const TRANSIENT_KINDS: ReadonlySet<CodeHostErrorKind> = new Set<CodeHostErrorKind>(["timeout", "unavailable", "rate_limited", "bad_response"]);

/** A failure that ends the publish with a typed reason before or without the writer. */
class PublishRefused extends Error {
  readonly reason: CodeFixReason;
  readonly kind: CodeHostErrorKind | null;
  constructor(reason: CodeFixReason, kind: CodeHostErrorKind | null = null) {
    super(reason);
    this.name = "PublishRefused";
    this.reason = reason;
    this.kind = kind;
  }
}

const CODEHOST_KINDS: ReadonlySet<string> = new Set<CodeHostErrorKind>([
  "auth", "forbidden", "not_found", "conflict", "rate_limited", "timeout", "unavailable", "bad_response", "unsafe_input",
]);

/** A CodeHostError of any code host implementation (structural: name and a known kind). */
function codeHostKind(e: unknown): CodeHostErrorKind | null {
  const err = e as { name?: unknown; kind?: unknown } | null;
  if (err && err.name === "CodeHostError" && typeof err.kind === "string" && CODEHOST_KINDS.has(err.kind)) return err.kind as CodeHostErrorKind;
  return null;
}

function retryAfterMs(e: unknown): number {
  const sec = (e as { retryAfterSec?: unknown } | null)?.retryAfterSec;
  return typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
}

export class CodeFixPublisher {
  private readonly d: CodeFixPublisherDeps;
  private readonly log: Logger;
  private readonly classify: typeof classifyAction;
  private readonly retry: PublishRetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(d: CodeFixPublisherDeps) {
    this.d = d;
    this.log = d.logger.child({ component: "code_fix_publisher" });
    this.classify = d.classify ?? classifyAction;
    this.retry = d.retry ?? PUBLISH_RETRY;
    this.sleep = d.sleep ?? ((ms) => delay(ms).then(() => undefined));
  }

  private redact(text: string): string {
    return redactSecrets(text, this.d.secrets);
  }

  /** Never throws (decision 17). */
  async publish(attemptId: string): Promise<void> {
    try {
      await this.run(attemptId);
    } catch (e) {
      this.log.error("code-fix publish interrupted; it is retried on the next start", {
        event: "code_fix_publish_interrupted", attemptId, error: (e as Error)?.name ?? "Error",
      });
    }
  }

  private async run(attemptId: string): Promise<void> {
    const { fixes } = this.d;
    const a = fixes.getAttempt(attemptId);
    if (!a) {
      this.log.warn("code-fix publish for an unknown attempt", { event: "code_fix_publish_skipped", attemptId });
      return;
    }
    if (a.status !== "approved" && a.status !== "publishing") {
      this.log.warn("code-fix publish refused: the attempt is not approved", { event: "code_fix_publish_skipped", attemptId, status: a.status });
      return;
    }
    let cur: CodeFixAttempt = a.status === "approved" ? this.write(a, { ...a, status: "publishing", stage: "publish" }) : a;

    const maxTries = Math.max(1, Math.floor(this.retry.maxTries));
    for (let tryNo = 1; ; tryNo++) {
      try {
        const pr = await this.openPullRequest(cur, (commit) => {
          cur = this.write(cur, { ...cur, commit });
        });
        return this.finishOpened(cur, pr);
      } catch (e) {
        if (e instanceof PublishRefused) return this.finishFailed(cur, e.reason, e.kind);
        const kind = codeHostKind(e);
        if (kind === null) throw e; // a crash: the attempt stays publishing
        // A 409/422 the writer could not reconcile is the branch (or its pull request) pointing elsewhere.
        if (kind === "conflict") return this.finishFailed(cur, "ref_conflict", kind);
        if (!TRANSIENT_KINDS.has(kind)) return this.finishFailed(cur, "codehost_error", kind);
        if (tryNo < maxTries) {
          const backoff = this.retry.baseDelayMs * 2 ** (tryNo - 1);
          const wait = Math.min(this.retry.maxDelayMs, Math.max(backoff, retryAfterMs(e)));
          this.log.warn("code-fix publish hit a transient code-host error; retrying", {
            event: "code_fix_publish_retry", attemptId, kind, try: tryNo, waitMs: wait,
          });
          await this.sleep(wait);
          continue;
        }
        // Out of retries. No commit means no ref or pull request can exist: end it and release the key.
        if (cur.commit === null) return this.finishFailed(cur, "codehost_error", kind);
        // A branch, and maybe a pull request from a lost response, may exist: keep it publishing with the key held.
        this.log.warn("code-fix publish left publishing after transient code-host errors; it is retried on the next start", {
          event: "code_fix_publish_deferred", incidentId: cur.incidentId, attemptId, kind, tries: tryNo,
        });
        return;
      }
    }
  }

  /** The checks of decision 15, in order, then the writer. */
  private async openPullRequest(a: CodeFixAttempt, onCommit: (c: { sha: string; tree: string }) => void): Promise<PullRequestInfo> {
    const approval = a.approvalId === null ? null : this.d.fixes.getApproval(a.approvalId);
    if (!approval || approval.subject !== "code_fix" || approval.actionId !== a.id || approval.status !== "approved") {
      throw new PublishRefused("patch_mismatch");
    }
    // 1. The artifact is exactly what was approved.
    if (!this.artifactMatches(a, approval.patchSha256 ?? null)) throw new PublishRefused("patch_mismatch");
    if (a.baseCommitSha === null || a.patchReadyAt === null) throw new PublishRefused("patch_mismatch");

    // 2. The catalog still says tier 3 with valid params for the code fixer.
    const repo = this.d.config.repositories.find((r) => r.repo === a.repo);
    if (!repo) throw new PublishRefused("catalog_refused");
    const cls = this.classify(
      { actionType: DRAFT_PR_ACTION, target: `repository/${repo.service}`, params: { attemptId: a.id, patchSha256: a.patchSha256 }, runbookRef: null },
      { scope: { service: repo.service, account: null, incidentId: a.incidentId }, revisionsExhausted: false, knownRunbookRefs: new Set<string>(), proposer: "code_fixer" },
    );
    if (cls.tier !== 3 || !cls.known || !cls.executable || !cls.paramsOk) throw new PublishRefused("catalog_refused");

    const [owner, name] = a.repo.split("/") as [string, string];
    const ref = { owner, repo: name };
    // 3. The base branch is protected, as far as the token can see.
    const branch = await this.d.reader.branchInfo({ ...ref, branch: a.baseBranch });
    if (branch.protected !== true) throw new PublishRefused("base_unprotected");
    // 4. No patched file changed on the base since the base commit; nothing is rebased.
    const changed = new Set(await this.d.reader.compareFiles({ ...ref, base: a.baseCommitSha, head: a.baseBranch }));
    if (a.files.some((f) => changed.has(f.path))) throw new PublishRefused("stale_base");

    // 5 to 7. The writer: existing pull request, deterministic commit, ref, draft pull request.
    const links = { incidentUrl: this.incidentUrl(a.incidentId) };
    const title = this.redact(renderPullRequestTitle(a));
    return this.d.writer.openDraftPullRequest({
      ...ref,
      base: a.baseBranch,
      baseCommitSha: a.baseCommitSha,
      branch: FIX_BRANCH_PREFIX + a.id,
      title,
      body: this.redact(renderPullRequestBody(a, links)),
      commitMessage: this.redact(this.commitMessage(a, title)),
      author: { name: this.d.config.commitAuthor.name, email: this.d.config.commitAuthor.email, date: a.patchReadyAt },
      files: a.files.map((f) => ({ path: f.path, content: a.contents.find((c) => c.path === f.path)!.text })),
      onCommit,
    });
  }

  /** Every post-image hashes to its afterSha256, and the canonical payload hash equals the attempt's and the approval's. */
  private artifactMatches(a: CodeFixAttempt, approvedSha: string | null): boolean {
    if (a.patch === null || a.patchSha256 === null || approvedSha === null || a.files.length === 0) return false;
    if (a.contents.length !== a.files.length) return false;
    const paths = new Set(a.files.map((f) => f.path));
    if (paths.size !== a.files.length) return false;
    for (const f of a.files) {
      const post = a.contents.filter((c) => c.path === f.path);
      if (post.length !== 1 || sha256Hex(post[0]!.text) !== f.afterSha256) return false;
    }
    const sha = sha256Hex(canonicalPatchPayload(a.patch, a.files));
    return sha === a.patchSha256 && sha === approvedSha;
  }

  private incidentUrl(incidentId: string): string {
    const path = `/incidents/${encodeURIComponent(incidentId)}`;
    return this.d.publicUrl ? this.d.publicUrl.replace(/\/+$/, "") + path : path;
  }

  /** Facts only; no co-author or attribution line (decision 15). */
  private commitMessage(a: CodeFixAttempt, title: string): string {
    return [
      title,
      "",
      `Regression test and minimal fix for incident ${a.incidentId} (code-fix attempt ${a.id}).`,
      `Patch sha256: ${a.patchSha256}`,
      "",
    ].join("\n");
  }

  private write(a: CodeFixAttempt, next: CodeFixAttempt, opts: { keyHeld?: boolean } = {}): CodeFixAttempt {
    const version = this.d.fixes.updateAttempt(a.id, next, a.version, opts);
    return { ...next, version };
  }

  private finishOpened(a: CodeFixAttempt, pr: PullRequestInfo): void {
    const extra = pr as PullRequestInfo & { commitSha?: string | null; treeSha?: string | null };
    const commit = typeof extra.commitSha === "string" && typeof extra.treeSha === "string" ? { sha: extra.commitSha, tree: extra.treeSha } : a.commit;
    const pullRequest = { number: pr.number, url: this.redact(pr.url).slice(0, 2000), branch: this.redact(pr.branch).slice(0, 200) };
    const nowIso = this.d.clock.now().toISOString();
    this.d.fixes.transaction(() => {
      this.write(a, { ...a, status: "pr_opened", stage: "publish", reason: null, commit, pullRequest, finishedAt: nowIso });
      this.d.store.appendAudit({
        incidentId: a.incidentId, actor: ACTOR, event: "code_fix_pr_opened", tier: 3,
        details: { attemptId: a.id, prNumber: pullRequest.number, prUrl: pullRequest.url, branch: pullRequest.branch, patchSha256: a.patchSha256 },
      });
    });
    this.log.info("code-fix draft pull request opened", { event: "code_fix_pr_opened", incidentId: a.incidentId, attemptId: a.id, prNumber: pr.number });
  }

  private finishFailed(a: CodeFixAttempt, reason: CodeFixReason, kind: CodeHostErrorKind | null): void {
    const nowIso = this.d.clock.now().toISOString();
    // A codehost_error after the commit was persisted keeps the key: the branch, or a pull request from an earlier
    // lost response, may exist (AC-82; see the deviation note at the top of this file).
    const keyHeld = !isTransientReason(reason) || (reason === "codehost_error" && a.commit !== null);
    this.d.fixes.transaction(() => {
      this.write(a, { ...a, status: "publish_failed", stage: "publish", reason, finishedAt: nowIso }, { keyHeld });
      this.d.store.appendAudit({
        incidentId: a.incidentId, actor: ACTOR, event: "code_fix_publish_failed", tier: 3, details: { attemptId: a.id, reason, kind },
      });
    });
    this.log.warn("code-fix publish failed", { event: "code_fix_publish_failed", incidentId: a.incidentId, attemptId: a.id, reason, kind, keyHeld });
  }
}
