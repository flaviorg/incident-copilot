// Persistence of code-fix attempts and code-fix approvals (spec 009, decisions 14 and 16).
// Same style as the incident store: prepared statements, Zod parse on every read, optimistic versions, and the
// incident store's transaction() (so a write here joins a transaction opened there). Decides no business rules:
// whether an attempt holds the per-group key is derived by the caller (see isTransientReason).
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { ApprovalSchema, CodeFixAttemptSchema } from "../../contracts/index.ts";
import type { Approval, ApprovalStatus, CodeFixAttempt, CodeFixReason, CodeFixStatus } from "../../contracts/index.ts";
import { ConflictError } from "../../domain/errors.ts";

/** Give-up reasons that release the (repo, errorGroupId) key, so a later alert may try again (decision 16). */
export const TRANSIENT_REASONS: ReadonlySet<CodeFixReason> = new Set<CodeFixReason>([
  "interrupted", "attempt_timeout", "sandbox_error", "baseline_timeout", "workspace_failed", "author_unavailable",
  "reviewer_unavailable", "codehost_error",
]);

export const isTransientReason = (reason: CodeFixReason | null): boolean => reason !== null && TRANSIENT_REASONS.has(reason);

export type CodeFixApprovalFilter = { status?: ApprovalStatus; incidentId?: string; attemptId?: string };

/** What the store needs from the incident store: the same database and its (re-entrant) transaction helper. */
export type CodeFixStoreHost = { readonly db: DatabaseSync; transaction<T>(fn: () => T): T };

const SQLITE_CONSTRAINT_UNIQUE = 2067;

/** True when the error is the partial unique index on (repo, error_group_id) WHERE key_held = 1. */
const isKeyViolation = (e: unknown): boolean => {
  const err = e as { errcode?: unknown; message?: unknown };
  return err?.errcode === SQLITE_CONSTRAINT_UNIQUE && typeof err.message === "string" &&
    err.message.includes("code_fix_attempts.repo") && err.message.includes("code_fix_attempts.error_group_id");
};

export class SqliteCodeFixStore {
  private readonly host: CodeFixStoreHost;
  private readonly stmt: Record<string, StatementSync>;

  constructor(host: CodeFixStoreHost) {
    this.host = host;
    const p = (sql: string) => host.db.prepare(sql);
    this.stmt = {
      insertAttempt: p(
        `INSERT INTO code_fix_attempts (id, incident_id, repo, error_group_id, status, key_held, created_at, finished_at, version, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      getAttempt: p("SELECT json FROM code_fix_attempts WHERE id = ?"),
      updateAttempt: p(
        `UPDATE code_fix_attempts SET status = ?, key_held = COALESCE(?, key_held), finished_at = ?, version = ?, json = ?
         WHERE id = ? AND version = ? AND repo = ? AND error_group_id = ? AND incident_id = ?`,
      ),
      releaseKey: p("UPDATE code_fix_attempts SET key_held = 0 WHERE id = ?"),
      holdsKey: p("SELECT 1 AS held FROM code_fix_attempts WHERE repo = ? AND error_group_id = ? AND key_held = 1 LIMIT 1"),
      countStartedSince: p("SELECT COUNT(*) AS n FROM code_fix_attempts WHERE repo = ? AND status <> 'skipped' AND created_at >= ?"),
      countForGroup: p("SELECT COUNT(*) AS n FROM code_fix_attempts WHERE repo = ? AND error_group_id = ? AND status <> 'skipped'"),
      latestForIncident: p("SELECT json FROM code_fix_attempts WHERE incident_id = ? ORDER BY created_at DESC, id DESC LIMIT 1"),
      listByStatus: p(
        "SELECT json FROM code_fix_attempts WHERE status IN (SELECT value FROM json_each(?)) ORDER BY created_at, id",
      ),
      insertApproval: p(
        `INSERT INTO code_fix_approvals (id, incident_id, action_id, attempt_id, status, requested_at, expires_at, decided_at, version, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      getApproval: p("SELECT json FROM code_fix_approvals WHERE id = ?"),
      updateApproval: p("UPDATE code_fix_approvals SET status = ?, decided_at = ?, version = ?, json = ? WHERE id = ? AND version = ?"),
      listApprovals: p(
        `SELECT json FROM code_fix_approvals
         WHERE ($status IS NULL OR status = $status) AND ($incident IS NULL OR incident_id = $incident)
           AND ($attempt IS NULL OR attempt_id = $attempt)
         ORDER BY requested_at, id`,
      ),
    };
  }

  private s(name: string): StatementSync {
    const st = this.stmt[name];
    if (!st) throw new Error(`unknown statement: ${name}`);
    return st;
  }

  /** The incident store's transaction: re-entrant, so attempt, approval and audit writes can share one. */
  transaction<T>(fn: () => T): T {
    return this.host.transaction(fn);
  }

  // ---------- attempts ----------

  /**
   * Inserts the attempt at version 1. `keyHeld` is the caller's decision; a skipped row can never hold the key.
   * A second key-holding attempt for the same (repo, errorGroupId) throws ConflictError("already_attempted").
   */
  insertAttempt(a: CodeFixAttempt, opts: { keyHeld: boolean }): CodeFixAttempt {
    const at = CodeFixAttemptSchema.parse({ ...a, version: 1 });
    if (opts.keyHeld && at.status === "skipped") throw new TypeError(`insertAttempt: a skipped attempt cannot hold the key (${at.id})`);
    try {
      this.s("insertAttempt").run(
        at.id, at.incidentId, at.repo, at.errorGroupId, at.status, opts.keyHeld ? 1 : 0, at.startedAt, at.finishedAt, at.version, JSON.stringify(at),
      );
    } catch (e) {
      if (isKeyViolation(e)) throw new ConflictError("already_attempted", `error group ${at.errorGroupId} of ${at.repo} already has an attempt`);
      throw e;
    }
    return at;
  }

  getAttempt(id: string): CodeFixAttempt | null {
    const row = this.s("getAttempt").get(id) as { json: string } | undefined;
    return row ? CodeFixAttemptSchema.parse(JSON.parse(row.json)) : null;
  }

  /**
   * Optimistic version: writes only if the current version is `expectedVersion`; the written version is
   * `expectedVersion + 1`, which it returns. The repository, group and incident are fixed at insert.
   * `keyHeld` omitted keeps the current key; `false` releases it in the same write.
   */
  updateAttempt(id: string, next: CodeFixAttempt, expectedVersion: number, opts: { keyHeld?: boolean } = {}): number {
    if (next.id !== id) throw new TypeError(`updateAttempt: id mismatch (${id} and ${next.id})`);
    const at = CodeFixAttemptSchema.parse({ ...next, version: expectedVersion + 1 });
    if (opts.keyHeld === true && at.status === "skipped") throw new TypeError(`updateAttempt: a skipped attempt cannot hold the key (${id})`);
    const keyHeld = opts.keyHeld === undefined ? null : opts.keyHeld ? 1 : 0;
    let changes: number | bigint;
    try {
      changes = this.s("updateAttempt").run(
        at.status, keyHeld, at.finishedAt, at.version, JSON.stringify(at), id, expectedVersion, at.repo, at.errorGroupId, at.incidentId,
      ).changes;
    } catch (e) {
      if (isKeyViolation(e)) throw new ConflictError("already_attempted", `error group ${at.errorGroupId} of ${at.repo} already has an attempt`);
      throw e;
    }
    if (Number(changes) === 0) {
      throw new ConflictError("version_conflict", `code-fix attempt ${id} changed since version ${expectedVersion}`);
    }
    return at.version;
  }

  /** Releases the (repo, errorGroupId) key; for a transient give-up. The JSON and version are untouched. */
  releaseKey(id: string): void {
    this.s("releaseKey").run(id);
  }

  holdsKey(repo: string, errorGroupId: string): boolean {
    return this.s("holdsKey").get(repo, errorGroupId) !== undefined;
  }

  /** Attempts of the repository that entered `running` (every status but `skipped`) at or after `since` (daily cap). */
  countStartedSince(repo: string, since: string): number {
    return Number((this.s("countStartedSince").get(repo, since) as { n: number }).n);
  }

  /** Attempts of the group that entered `running` (skipped rows excluded), for `maxAttemptsPerGroup`. */
  countForGroup(repo: string, errorGroupId: string): number {
    return Number((this.s("countForGroup").get(repo, errorGroupId) as { n: number }).n);
  }

  latestForIncident(incidentId: string): CodeFixAttempt | null {
    const row = this.s("latestForIncident").get(incidentId) as { json: string } | undefined;
    return row ? CodeFixAttemptSchema.parse(JSON.parse(row.json)) : null;
  }

  /** Attempts in any of the statuses, oldest first (startup recovery of `running` and `publishing`). */
  listByStatus(statuses: readonly CodeFixStatus[]): CodeFixAttempt[] {
    if (statuses.length === 0) return [];
    const rows = this.s("listByStatus").all(JSON.stringify(statuses)) as { json: string }[];
    return rows.map((r) => CodeFixAttemptSchema.parse(JSON.parse(r.json)));
  }

  // ---------- code-fix approvals ----------

  /** Stores a code-fix approval: subject `code_fix`, a patch hash, and `actionId` holding an existing attempt id. */
  insertApproval(a: Approval): void {
    const ap = ApprovalSchema.parse(a);
    if (ap.subject !== "code_fix") throw new TypeError(`insertApproval: approval ${ap.id} is not a code-fix approval`);
    if (ap.patchSha256 === undefined) throw new TypeError(`insertApproval: approval ${ap.id} has no patch hash`);
    this.s("insertApproval").run(
      ap.id, ap.incidentId, ap.actionId, ap.actionId, ap.status, ap.requestedAt, ap.expiresAt, ap.decidedAt, ap.version, JSON.stringify(ap),
    );
  }

  getApproval(id: string): Approval | null {
    const row = this.s("getApproval").get(id) as { json: string } | undefined;
    return row ? ApprovalSchema.parse(JSON.parse(row.json)) : null;
  }

  /** Optimistic version: writes only if the current version is `expectedVersion`; the written version is `expectedVersion + 1`. */
  transitionApproval(id: string, next: Approval, expectedVersion: number): void {
    if (next.id !== id) throw new TypeError(`transitionApproval: id mismatch (${id} and ${next.id})`);
    const ap = ApprovalSchema.parse({ ...next, version: expectedVersion + 1 });
    if (ap.subject !== "code_fix" || ap.patchSha256 === undefined) throw new TypeError(`transitionApproval: approval ${id} is not a code-fix approval`);
    const result = this.s("updateApproval").run(ap.status, ap.decidedAt, ap.version, JSON.stringify(ap), id, expectedVersion);
    if (Number(result.changes) === 0) {
      throw new ConflictError("version_conflict", `code-fix approval ${id} changed since version ${expectedVersion}`);
    }
  }

  listApprovals(f: CodeFixApprovalFilter): Approval[] {
    const rows = this.s("listApprovals").all({
      status: f.status ?? null, incident: f.incidentId ?? null, attempt: f.attemptId ?? null,
    }) as { json: string }[];
    return rows.map((r) => ApprovalSchema.parse(JSON.parse(r.json)));
  }
}
