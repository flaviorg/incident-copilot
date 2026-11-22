import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../src/infra/db/sqlite.ts";
import { SqliteIncidentStore } from "../../src/infra/db/incident-store.ts";
import { SqliteCodeFixStore, TRANSIENT_REASONS, isTransientReason } from "../../src/infra/db/code-fix-store.ts";
import { ConflictError } from "../../src/domain/errors.ts";
import type { Approval, CodeFixAttempt, NewIncident } from "../../src/contracts/index.ts";

const SHA = "a".repeat(64);

const mk = () => {
  const incidents = new SqliteIncidentStore(openDatabase(":memory:"), { secrets: [], now: () => new Date("2026-11-20T10:00:00Z") });
  incidents.createIncident(incident());
  incidents.createIncident(incident({ id: "INC-0002" }));
  return { incidents, fixes: new SqliteCodeFixStore(incidents) };
};

const incident = (o: Partial<NewIncident> = {}): NewIncident => ({
  id: "INC-0001", title: "TypeError in cart", service: "tiny-cart", severity: "sev2", scenarioId: "live",
  openedAt: "2026-11-20T09:00:00.000Z", impactStartedAt: "2026-11-20T09:00:00.000Z", detectedAt: "2026-11-20T09:00:00.000Z", ...o,
});

const attempt = (o: Partial<CodeFixAttempt> = {}): CodeFixAttempt => ({
  id: "fix_00000001", incidentId: "INC-0001", repo: "acme/tiny-cart", service: "tiny-cart", connectorId: "sentry-prod",
  errorGroupId: "G1", mode: "shadow", isolation: "isolated", status: "running", stage: "locate", reason: null, violations: [],
  release: "v1.2.0", commitSha: "b".repeat(40), baseBranch: "main", baseCommitSha: null, exception: { type: "TypeError", value: "x is undefined" },
  anchor: null, files: [], patch: null, patchSha256: null, contents: [],
  evidence: { baseline: null, reproBefore: [], fixAfter: [], suiteAfter: null },
  review: null, suggestion: null, approvalId: null, commit: null, pullRequest: null,
  llm: { calls: 0, promptTokens: 0, completionTokens: 0 },
  startedAt: "2026-11-20T09:30:00.000Z", patchReadyAt: null, finishedAt: null, version: 0, ...o,
});

const approval = (o: Partial<Approval> = {}): Approval => ({
  id: "APR-0101", incidentId: "INC-0001", actionId: "fix_00000001", status: "pending", requestedAt: "2026-11-20T09:40:00.000Z",
  expiresAt: "2026-11-23T09:40:00.000Z", decidedAt: null, approver: null, comment: null, decisionSource: null, version: 0,
  subject: "code_fix", patchSha256: SHA, ...o,
});

const conflictCode = (code: string) => (e: unknown) => e instanceof ConflictError && e.code === code;

test("insertAttempt and getAttempt round-trip; an unknown id is null", () => {
  const { fixes } = mk();
  const a = attempt();
  fixes.insertAttempt(a, { keyHeld: true });
  assert.deepEqual(fixes.getAttempt(a.id), { ...a, version: 1 });
  assert.equal(fixes.getAttempt("fix_99999999"), null);
});

test("updateAttempt bumps the version and refuses a stale version", () => {
  const { fixes } = mk();
  fixes.insertAttempt(attempt(), { keyHeld: true });
  const v = fixes.updateAttempt("fix_00000001", { ...attempt(), stage: "baseline" }, 1);
  assert.equal(v, 2);
  assert.equal(fixes.getAttempt("fix_00000001")!.stage, "baseline");
  assert.equal(fixes.getAttempt("fix_00000001")!.version, 2);
  assert.throws(() => fixes.updateAttempt("fix_00000001", { ...attempt(), stage: "repro" }, 1), conflictCode("version_conflict"));
  assert.equal(fixes.getAttempt("fix_00000001")!.stage, "baseline");
  assert.throws(() => fixes.updateAttempt("fix_00000001", attempt({ id: "fix_00000002" }), 2), TypeError);
});

test("one key-holding attempt per (repo, errorGroupId): a second one is already_attempted", () => {
  const { fixes } = mk();
  assert.equal(fixes.holdsKey("acme/tiny-cart", "G1"), false);
  fixes.insertAttempt(attempt(), { keyHeld: true });
  assert.equal(fixes.holdsKey("acme/tiny-cart", "G1"), true);
  assert.throws(() => fixes.insertAttempt(attempt({ id: "fix_00000002" }), { keyHeld: true }), conflictCode("already_attempted"));
  assert.equal(fixes.getAttempt("fix_00000002"), null);
  // other group or other repository: no conflict
  fixes.insertAttempt(attempt({ id: "fix_00000003", errorGroupId: "G2" }), { keyHeld: true });
  fixes.insertAttempt(attempt({ id: "fix_00000004", repo: "acme/other" }), { keyHeld: true });
  assert.equal(fixes.holdsKey("acme/tiny-cart", "G2"), true);
});

test("a duplicate id is not reported as already_attempted", () => {
  const { fixes } = mk();
  fixes.insertAttempt(attempt({ status: "skipped", reason: "low_confidence" }), { keyHeld: false });
  assert.throws(
    () => fixes.insertAttempt(attempt({ status: "skipped", reason: "low_confidence" }), { keyHeld: false }),
    (e: unknown) => !(e instanceof ConflictError),
  );
});

test("skipped rows never hold the key and never conflict", () => {
  const { fixes } = mk();
  fixes.insertAttempt(attempt({ id: "fix_00000001", status: "skipped", reason: "already_attempted" }), { keyHeld: false });
  fixes.insertAttempt(attempt({ id: "fix_00000002", status: "skipped", reason: "already_attempted" }), { keyHeld: false });
  assert.equal(fixes.holdsKey("acme/tiny-cart", "G1"), false);
  fixes.insertAttempt(attempt({ id: "fix_00000003" }), { keyHeld: true });
  fixes.insertAttempt(attempt({ id: "fix_00000004", status: "skipped", reason: "already_attempted" }), { keyHeld: false });
  assert.equal(fixes.holdsKey("acme/tiny-cart", "G1"), true);
});

test("a skipped row cannot hold the key", () => {
  const { fixes } = mk();
  assert.throws(() => fixes.insertAttempt(attempt({ status: "skipped", reason: "low_confidence" }), { keyHeld: true }), TypeError);
});

test("releaseKey after a transient give-up lets a new attempt start", () => {
  const { fixes } = mk();
  fixes.insertAttempt(attempt(), { keyHeld: true });
  const gaveUp = attempt({ status: "gave_up", reason: "sandbox_error", finishedAt: "2026-11-20T09:35:00.000Z" });
  fixes.updateAttempt("fix_00000001", gaveUp, 1);
  assert.equal(fixes.holdsKey("acme/tiny-cart", "G1"), true);
  fixes.releaseKey("fix_00000001");
  assert.equal(fixes.holdsKey("acme/tiny-cart", "G1"), false);
  assert.equal(fixes.getAttempt("fix_00000001")!.status, "gave_up");
  fixes.insertAttempt(attempt({ id: "fix_00000002" }), { keyHeld: true });
  assert.equal(fixes.holdsKey("acme/tiny-cart", "G1"), true);
});

test("updateAttempt can release the key in the same write", () => {
  const { fixes } = mk();
  fixes.insertAttempt(attempt(), { keyHeld: true });
  fixes.updateAttempt("fix_00000001", attempt({ status: "gave_up", reason: "interrupted" }), 1, { keyHeld: false });
  assert.equal(fixes.holdsKey("acme/tiny-cart", "G1"), false);
  // omitting keyHeld keeps it as it is
  fixes.insertAttempt(attempt({ id: "fix_00000002" }), { keyHeld: true });
  fixes.updateAttempt("fix_00000002", attempt({ id: "fix_00000002", status: "patch_ready" }), 1);
  assert.equal(fixes.holdsKey("acme/tiny-cart", "G1"), true);
});

test("transient reasons are exactly the ones of decision 16", () => {
  assert.deepEqual([...TRANSIENT_REASONS].sort(), [
    "attempt_timeout", "author_unavailable", "baseline_timeout", "codehost_error", "interrupted", "reviewer_unavailable",
    "sandbox_error", "workspace_failed",
  ]);
  assert.equal(isTransientReason("sandbox_error"), true);
  assert.equal(isTransientReason("fix_not_passing"), false);
  assert.equal(isTransientReason(null), false);
});

test("countStartedSince counts non-skipped attempts of the repository since the instant", () => {
  const { fixes } = mk();
  fixes.insertAttempt(attempt({ id: "fix_00000001", startedAt: "2026-11-19T08:00:00.000Z", status: "gave_up", reason: "interrupted" }), { keyHeld: false });
  fixes.insertAttempt(attempt({ id: "fix_00000002", startedAt: "2026-11-20T08:00:00.000Z", errorGroupId: "G2" }), { keyHeld: true });
  fixes.insertAttempt(attempt({ id: "fix_00000003", startedAt: "2026-11-20T09:00:00.000Z", errorGroupId: "G3" }), { keyHeld: true });
  fixes.insertAttempt(attempt({ id: "fix_00000004", startedAt: "2026-11-20T09:10:00.000Z", status: "skipped", reason: "low_confidence" }), { keyHeld: false });
  fixes.insertAttempt(attempt({ id: "fix_00000005", startedAt: "2026-11-20T09:20:00.000Z", repo: "acme/other" }), { keyHeld: true });
  assert.equal(fixes.countStartedSince("acme/tiny-cart", "2026-11-19T10:00:00.000Z"), 2);
  assert.equal(fixes.countStartedSince("acme/tiny-cart", "2026-11-19T00:00:00.000Z"), 3);
  assert.equal(fixes.countStartedSince("acme/other", "2026-11-19T10:00:00.000Z"), 1);
});

test("countForGroup counts the attempts of one group that entered running", () => {
  const { fixes } = mk();
  fixes.insertAttempt(attempt({ id: "fix_00000001", status: "gave_up", reason: "sandbox_error" }), { keyHeld: false });
  fixes.insertAttempt(attempt({ id: "fix_00000002", status: "gave_up", reason: "interrupted" }), { keyHeld: false });
  fixes.insertAttempt(attempt({ id: "fix_00000003", status: "skipped", reason: "already_attempted" }), { keyHeld: false });
  fixes.insertAttempt(attempt({ id: "fix_00000004", errorGroupId: "G2" }), { keyHeld: true });
  assert.equal(fixes.countForGroup("acme/tiny-cart", "G1"), 2);
  assert.equal(fixes.countForGroup("acme/tiny-cart", "G2"), 1);
  assert.equal(fixes.countForGroup("acme/tiny-cart", "G9"), 0);
});

test("latestForIncident returns the newest attempt of the incident", () => {
  const { fixes } = mk();
  assert.equal(fixes.latestForIncident("INC-0001"), null);
  fixes.insertAttempt(attempt({ id: "fix_00000001", startedAt: "2026-11-20T09:00:00.000Z", status: "gave_up", reason: "interrupted" }), { keyHeld: false });
  fixes.insertAttempt(attempt({ id: "fix_00000002", startedAt: "2026-11-20T09:30:00.000Z" }), { keyHeld: true });
  fixes.insertAttempt(attempt({ id: "fix_00000003", incidentId: "INC-0002", startedAt: "2026-11-20T10:00:00.000Z", errorGroupId: "G2" }), { keyHeld: true });
  assert.equal(fixes.latestForIncident("INC-0001")!.id, "fix_00000002");
  assert.equal(fixes.latestForIncident("INC-0002")!.id, "fix_00000003");
});

test("listByStatus returns the attempts in the given statuses, oldest first", () => {
  const { fixes } = mk();
  fixes.insertAttempt(attempt({ id: "fix_00000001", startedAt: "2026-11-20T09:00:00.000Z", status: "publishing" }), { keyHeld: true });
  fixes.insertAttempt(attempt({ id: "fix_00000002", startedAt: "2026-11-20T09:10:00.000Z", errorGroupId: "G2" }), { keyHeld: true });
  fixes.insertAttempt(attempt({ id: "fix_00000003", startedAt: "2026-11-20T09:20:00.000Z", errorGroupId: "G3", status: "pr_opened" }), { keyHeld: true });
  assert.deepEqual(fixes.listByStatus(["running", "publishing"]).map((a) => a.id), ["fix_00000001", "fix_00000002"]);
  assert.deepEqual(fixes.listByStatus([]), []);
});

test("code-fix approvals: insert, get, optimistic transition and list", () => {
  const { fixes } = mk();
  fixes.insertAttempt(attempt({ status: "awaiting_approval" }), { keyHeld: true });
  fixes.insertApproval(approval());
  assert.deepEqual(fixes.getApproval("APR-0101"), approval());
  assert.equal(fixes.getApproval("APR-9999"), null);
  const approved = approval({ status: "approved", decidedAt: "2026-11-20T10:00:00.000Z", approver: "ana", decisionSource: "structured" });
  fixes.transitionApproval("APR-0101", approved, 0);
  assert.deepEqual(fixes.getApproval("APR-0101"), { ...approved, version: 1 });
  assert.throws(() => fixes.transitionApproval("APR-0101", approved, 0), conflictCode("version_conflict"));
  assert.throws(() => fixes.transitionApproval("APR-0101", approval({ id: "APR-0102" }), 1), TypeError);

  fixes.insertAttempt(attempt({ id: "fix_00000002", incidentId: "INC-0002", errorGroupId: "G2", status: "awaiting_approval" }), { keyHeld: true });
  fixes.insertApproval(approval({ id: "APR-0102", incidentId: "INC-0002", actionId: "fix_00000002", requestedAt: "2026-11-20T09:50:00.000Z" }));
  assert.deepEqual(fixes.listApprovals({}).map((a) => a.id), ["APR-0101", "APR-0102"]);
  assert.deepEqual(fixes.listApprovals({ status: "pending" }).map((a) => a.id), ["APR-0102"]);
  assert.deepEqual(fixes.listApprovals({ status: "approved" }).map((a) => a.id), ["APR-0101"]);
  assert.deepEqual(fixes.listApprovals({ incidentId: "INC-0002" }).map((a) => a.id), ["APR-0102"]);
});

test("insertApproval refuses an approval without the code_fix subject or patch hash, or for an unknown attempt", () => {
  const { fixes } = mk();
  fixes.insertAttempt(attempt({ status: "awaiting_approval" }), { keyHeld: true });
  const { subject: _s, ...noSubject } = approval();
  const { patchSha256: _p, ...noHash } = approval();
  assert.throws(() => fixes.insertApproval(noSubject as Approval), TypeError);
  assert.throws(() => fixes.insertApproval(noHash as Approval), TypeError);
  assert.throws(() => fixes.insertApproval(approval({ actionId: "fix_00000077" })));
  assert.deepEqual(fixes.listApprovals({}), []);
});

test("SqliteIncidentStore.listApprovals never returns a code-fix approval", () => {
  const { incidents, fixes } = mk();
  fixes.insertAttempt(attempt({ status: "awaiting_approval" }), { keyHeld: true });
  fixes.insertApproval(approval());
  assert.deepEqual(incidents.listApprovals({}), []);
  assert.deepEqual(incidents.listApprovals({ status: "pending" }), []);
  assert.deepEqual(incidents.listApprovals({ incidentId: "INC-0001" }), []);
  assert.equal(incidents.getApproval("APR-0101"), null);
});

test("writes join the incident store's transaction and roll back with it", () => {
  const { incidents, fixes } = mk();
  assert.throws(() =>
    incidents.transaction(() => {
      fixes.insertAttempt(attempt({ status: "awaiting_approval" }), { keyHeld: true });
      fixes.insertApproval(approval());
      throw new Error("boom");
    }),
  );
  assert.equal(fixes.getAttempt("fix_00000001"), null);
  assert.equal(fixes.getApproval("APR-0101"), null);
  incidents.transaction(() => {
    fixes.insertAttempt(attempt({ status: "awaiting_approval" }), { keyHeld: true });
    fixes.insertApproval(approval());
  });
  assert.equal(fixes.getApproval("APR-0101")!.status, "pending");
});
