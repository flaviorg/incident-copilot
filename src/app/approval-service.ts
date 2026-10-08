// Decisões humanas sobre aprovações (spec 5.1 passo 10, 6.5 e 6.6; AC-13 a AC-18). O token é comparado em tempo
// constante e nunca ecoado; o texto livre só vale se for exatamente um termo das listas; o LLM nunca decide.
// Sem pendências restantes, a última decisão dispara a retomada pelo executor. A retomada que escala (inclusive por
// LLM indisponível ou timeout) devolve a view escalada: decide não lança nesse caso.
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

export type ApprovalServiceDeps = {
  store: SqliteIncidentStore;
  incidents: IncidentService;
  clock: Clock;
  approvalToken: string | null;
  attempts: TokenAttemptLimiter;
  secrets: readonly string[];
  logger: Logger;
};

const clipId = (id: string) => (id.length <= 64 ? id : id.slice(0, 63) + "…");

export class ApprovalService {
  private readonly d: ApprovalServiceDeps;

  constructor(d: ApprovalServiceDeps) {
    this.d = d;
  }

  /**
   * Ordem do spec 6.5: corpo, token configurado, bloqueio, token, texto ambíguo, aprovação existe, expiração,
   * pendente, transição. Expirada: materializa a expiração do incidente, retoma se não restar pendência e responde
   * approval_expired.
   */
  async decide(approvalId: string, body: DecisionBody, token: string | undefined, ctx: RunCtx): Promise<{ approval: Approval; incident: IncidentView }> {
    const { store, clock, incidents } = this.d;
    const parsed = parseWithIssues(DecisionBodySchema, body);
    if (!parsed.success) throw new ValidationError(`decisão inválida: ${formatIssues(parsed.issues)}`, parsed.issues);
    const input = parsed.data;
    const now = clock.now();
    const log = this.d.logger.child({ requestId: ctx.requestId, approvalId: clipId(approvalId) });

    if (this.d.approvalToken === null) throw new ApprovalsDisabledError();
    if (this.d.attempts.isLocked(now)) {
      log.warn("decisão recusada: bloqueio por tentativas de token", { event: "approvals_locked" });
      throw new LockedError();
    }
    if (token === undefined || !constantTimeEqualsText(token, this.d.approvalToken)) {
      this.d.attempts.recordFailure(now);
      const known = store.getApproval(approvalId);
      store.appendAudit({
        incidentId: known?.incidentId ?? "-",
        actor: "system:approval-service",
        event: "approval_auth_failed",
        tier: null,
        details: { approvalId: clipId(approvalId), tokenPresent: token !== undefined, requestId: ctx.requestId },
      });
      log.warn("token de aprovação inválido ou ausente", { event: "approval_auth_failed" });
      throw new AuthError();
    }

    let decision: "approve" | "reject";
    let source: "structured" | "text";
    if (input.text !== undefined) {
      const p = parseDecision(input.text);
      if (p === "ambiguous") throw new UnprocessableError("ambiguous_decision", "decisão ambígua: responda exatamente aprovar ou rejeitar (também valem sim, não, approve, reject)");
      decision = p;
      source = "text";
    } else {
      decision = input.decision!;
      source = "structured";
    }

    const approval = store.getApproval(approvalId);
    if (!approval) throw new NotFoundError("not_found", `aprovação não encontrada: ${clipId(approvalId)}`);
    if (isExpired(approval, now)) {
      const { expired, pendingLeft } = incidents.expireDueApprovals(approval.incidentId, now, ctx);
      log.info("aprovação vencida materializada", { event: "approval_expired", incidentId: approval.incidentId, expired: expired.map((a) => a.id) });
      if (pendingLeft === 0) await this.resumeIfReady(approval.incidentId, ctx);
      throw new ConflictError("approval_expired", `a aprovação ${approval.id} expirou em ${approval.expiresAt}`);
    }
    if (approval.status !== "pending") throw new ConflictError("approval_not_pending", `a aprovação ${approval.id} já foi decidida (${approval.status})`);

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
        ? new ConflictError("approval_expired", `a aprovação ${approval.id} expirou em ${approval.expiresAt}`)
        : new ConflictError("approval_not_pending", `a aprovação ${approval.id} não está pendente`);
    }
    const { pendingLeft } = incidents.applyDecision(approval, next, ctx);
    log.info("decisão registrada", { event: next.status === "approved" ? "approval_approved" : "approval_rejected", incidentId: approval.incidentId, pendingLeft });
    const incident = pendingLeft === 0 ? ((await this.resumeIfReady(approval.incidentId, ctx)) ?? incidents.get(approval.incidentId)) : incidents.get(approval.incidentId);
    const stored = store.getApproval(approval.id)!;
    return { approval: { ...stored, status: effectiveStatus(stored, clock.now()) }, incident };
  }

  /** Aprovações com o status efetivo pedido (vencida aparece como expired); não grava nada. */
  list(status: ApprovalStatus): Approval[] {
    const now = this.d.clock.now();
    return this.d.store
      .listApprovals({})
      .map((a) => ({ ...a, status: effectiveStatus(a, now) }))
      .filter((a) => a.status === status);
  }

  /** Retoma só se a decisão deixou o incidente na fase resume. */
  private async resumeIfReady(incidentId: string, ctx: RunCtx): Promise<IncidentView | null> {
    if (this.d.store.loadBlackboard(incidentId).blackboard.phase !== "resume") return null;
    return this.d.incidents.resume(incidentId, ctx);
  }
}
