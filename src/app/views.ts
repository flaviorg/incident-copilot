// Read views built from the store (spec 5.3). Approvals come out with the effective status, writing nothing.
import type { Approval, AuditEntry, AuditEntryView, Blackboard, CodeFixAttempt, CodeFixAttemptView, Incident, IncidentView } from "../contracts/index.ts";
import { effectiveStatus } from "../domain/approval/approval-machine.ts";
import { redactSecrets } from "../infra/redact.ts";

export function toIncidentView(i: Incident, bb: Blackboard, approvals: Approval[], traceCount: number, now: Date): IncidentView {
  return {
    incident: i,
    diagnosis: bb.diagnosis,
    runbookMatches: bb.runbookMatches,
    plan: bb.plan,
    planRevision: bb.planRevision,
    audit: bb.audit,
    actions: bb.actions,
    approvals: approvals.map((a) => ({ ...a, status: effectiveStatus(a, now) })),
    verification: bb.verification,
    metrics: bb.metrics,
    postmortemReady: bb.postmortem !== null,
    traceCount,
  };
}

/**
 * Audit trail row with prevHash and hash, so the client can verify the chain; incidentId is left out since it is already in the URL.
 * Each incident has its own chain (the first row points to the genesis hash), so the returned trail closes
 * on its own even with incidents interleaved in the database.
 */
export function toAuditEntryView(e: AuditEntry): AuditEntryView {
  return { id: e.id, ts: e.ts, actor: e.actor, event: e.event, tier: e.tier, details: e.details, prevHash: e.prevHash, hash: e.hash };
}

/**
 * Code-fix attempt as it leaves the process (spec 009, decision 21; AC-79): the post-images (`contents`) are left out,
 * the patch stays, and every string goes through redactSecrets.
 */
export function toCodeFixView(a: CodeFixAttempt, secrets: readonly string[]): CodeFixAttemptView {
  const { contents: _contents, ...view } = a;
  return redactSecrets(view, secrets);
}
