// Human decisions on approvals (spec 5.1 step 10, 6.5 and 6.6; AC-13 to AC-18). The token is compared in constant
// time and never echoed; free text only counts if it is exactly one term from the lists; the LLM never decides.
// With no pending approvals left, the last decision triggers the resume by the executor. A resume that escalates (including due to
// LLM unavailable or timeout) returns the escalated view: decide does not throw in that case.
import { DecisionBodySchema } from "../contracts/index.ts";
import type { Approval, ApprovalStatus, DecisionBody, IncidentView } from "../contracts/index.ts";
import type { SqliteIncidentStore } from "../infra/db/incident-store.ts";
import type { Clock } from "../infra/clock.ts";
import type { Logger } from "../infra/logger.ts";
import { constantTimeEqualsText } from "../infra/crypto.ts";
import { redactSecrets } from "../infra/redact.ts";
import {
  ApprovalTransitionError, ApprovalsDisabledError, AuthError, ConflictError, LockedError, NotFoundError, UnprocessableError, ValidationError,
} from "../domain/errors.ts";
import { effectiveStatus, isExpired, transition } from "../domain/approval/approval-machine.ts";
import { parseDecision } from "../domain/approval/parse-decision.ts";
import type { TokenAttemptLimiter } from "../domain/guards/token-attempt-limiter.ts";
import { formatIssues, parseWithIssues } from "../domain/validation.ts";
import type { IncidentService, RunCtx } from "./incident-service.ts";
import type { CodeFixDecisionInput } from "./code-fix-service.ts";

/** What ApprovalService needs from the code fixer (spec 009, decision 14): its own approvals table and decision path. */
export type CodeFixApprovals = {
  getApproval(id: string): Approval | null;
  /** Every code-fix approval, with overdue ones materialized as expired. */
  listApprovals(ctx?: RunCtx): Approval[];
  decide(approvalId: string, input: CodeFixDecisionInput, ctx: RunCtx): Approval;
};

export type ApprovalServiceDeps = {
  store: SqliteIncidentStore;
  incidents: IncidentService;
  clock: Clock;
  approvalToken: string | null;
  attempts: TokenAttemptLimiter;
  secrets: readonly string[];
  logger: Logger;
  /** The code fixer's approvals (spec 009), or null/absent when the fixer is off. */
  codeFix?: CodeFixApprovals | null;
};

const clipId = (id: string) => (id.length <= 64 ? id : id.slice(0, 63) + "…");

export class ApprovalService {
  private readonly d: ApprovalServiceDeps;

  constructor(d: ApprovalServiceDeps) {
    this.d = d;
  }

  /**
   * Order from spec 6.5: body, configured token, lockout, token, ambiguous text, approval exists, expiry,
   * pending, transition. Expired: materializes the incident's expiry, resumes if no pending remain and responds
   * approval_expired. An id found only in code_fix_approvals branches right after the lookup, before any expiry
   * handling, to CodeFixService.decide (spec 009, decision 14), which never touches the incident.
   */
  async decide(approvalId: string, body: DecisionBody, token: string | undefined, ctx: RunCtx): Promise<{ approval: Approval; incident: IncidentView }> {
    const { store, clock, incidents } = this.d;
    const parsed = parseWithIssues(DecisionBodySchema, body);
    if (!parsed.success) throw new ValidationError(`invalid decision: ${formatIssues(parsed.issues)}`, parsed.issues);
    const input = parsed.data;
    const now = clock.now();
    const log = this.d.logger.child({ requestId: ctx.requestId, approvalId: clipId(approvalId) });

    if (this.d.approvalToken === null) throw new ApprovalsDisabledError();
    if (this.d.attempts.isLocked(now)) {
      log.warn("decision refused: locked out after token attempts", { event: "approvals_locked" });
      throw new LockedError();
    }
    if (token === undefined || !constantTimeEqualsText(token, this.d.approvalToken)) {
      this.d.attempts.recordFailure(now);
      const known = store.getApproval(approvalId) ?? this.d.codeFix?.getApproval(approvalId) ?? null;
      store.appendAudit({
        incidentId: known?.incidentId ?? "-",
        actor: "system:approval-service",
        event: "approval_auth_failed",
        tier: null,
        details: { approvalId: clipId(approvalId), tokenPresent: token !== undefined, requestId: ctx.requestId },
      });
      log.warn("invalid or missing approval token", { event: "approval_auth_failed" });
      throw new AuthError();
    }

    let decision: "approve" | "reject";
    let source: "structured" | "text";
    if (input.text !== undefined) {
      const p = parseDecision(input.text);
      if (p === "ambiguous") throw new UnprocessableError("ambiguous_decision", "ambiguous decision: reply exactly approve or reject (yes, no, aprovar, rejeitar, sim and não also work)");
      decision = p;
      source = "text";
    } else {
      decision = input.decision!;
      source = "structured";
    }

    const approval = store.getApproval(approvalId);
    if (!approval) {
      const codeFix = this.d.codeFix ?? null;
      if (!codeFix || codeFix.getApproval(approvalId) === null) throw new NotFoundError("not_found", `approval not found: ${clipId(approvalId)}`);
      const decided = codeFix.decide(approvalId, {
        decision,
        approver: redactSecrets(input.approver, this.d.secrets),
        comment: input.comment === undefined ? null : redactSecrets(input.comment, this.d.secrets),
        source,
      }, ctx);
      return { approval: { ...decided, status: effectiveStatus(decided, clock.now()) }, incident: incidents.get(decided.incidentId) };
    }
    if (isExpired(approval, now)) {
      const { expired, pendingLeft } = incidents.expireDueApprovals(approval.incidentId, now, ctx);
      log.info("overdue approval materialized as expired", { event: "approval_expired", incidentId: approval.incidentId, expired: expired.map((a) => a.id) });
      if (pendingLeft === 0) await this.resumeIfReady(approval.incidentId, ctx);
      throw new ConflictError("approval_expired", `approval ${approval.id} expired at ${approval.expiresAt}`);
    }
    if (approval.status !== "pending") throw new ConflictError("approval_not_pending", `approval ${approval.id} was already decided (${approval.status})`);

    const next = transition(
      approval,
      {
        type: decision,
        approver: redactSecrets(input.approver, this.d.secrets),
        comment: input.comment === undefined ? null : redactSecrets(input.comment, this.d.secrets),
        source,
      },
      now,
    );
    if (next instanceof ApprovalTransitionError) {
      throw next.code === "expired"
        ? new ConflictError("approval_expired", `approval ${approval.id} expired at ${approval.expiresAt}`)
        : new ConflictError("approval_not_pending", `approval ${approval.id} is not pending`);
    }
    const { pendingLeft } = incidents.applyDecision(approval, next, ctx);
    log.info("decision recorded", { event: next.status === "approved" ? "approval_approved" : "approval_rejected", incidentId: approval.incidentId, pendingLeft });
    const incident = pendingLeft === 0 ? ((await this.resumeIfReady(approval.incidentId, ctx)) ?? incidents.get(approval.incidentId)) : incidents.get(approval.incidentId);
    const stored = store.getApproval(approval.id)!;
    return { approval: { ...stored, status: effectiveStatus(stored, clock.now()) }, incident };
  }

  /**
   * Approvals with the requested effective status (overdue shows as expired). Action approvals are read only; code-fix
   * approvals (spec 009) follow them, with their expiry materialized on read, and carry `subject` and `patchSha256`.
   */
  list(status: ApprovalStatus): Approval[] {
    const now = this.d.clock.now();
    const actions = this.d.store
      .listApprovals({})
      .map((a) => ({ ...a, status: effectiveStatus(a, now) }))
      .filter((a) => a.status === status);
    const fixes = (this.d.codeFix?.listApprovals() ?? []).filter((a) => a.status === status);
    return fixes.length === 0 ? actions : [...actions, ...fixes];
  }

  /** Resumes only if the decision left the incident in phase resume. */
  private async resumeIfReady(incidentId: string, ctx: RunCtx): Promise<IncidentView | null> {
    if (this.d.store.loadBlackboard(incidentId).blackboard.phase !== "resume") return null;
    return this.d.incidents.resume(incidentId, ctx);
  }
}
