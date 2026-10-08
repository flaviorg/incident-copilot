// Visões de leitura montadas a partir do store (spec 5.3). Aprovações saem com o status efetivo, sem gravar nada.
import type { Approval, AuditEntry, AuditEntryView, Blackboard, Incident, IncidentView } from "../contracts/index.ts";
import { effectiveStatus } from "../domain/approval/approval-machine.ts";

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
 * Linha da trilha com prevHash e hash, para o cliente verificar a cadeia; incidentId fica de fora porque já está na URL.
 * Cada incidente tem a própria cadeia (a primeira linha aponta para o hash gênese), então a trilha devolvida fecha
 * sozinha mesmo com incidentes intercalados no banco.
 */
export function toAuditEntryView(e: AuditEntry): AuditEntryView {
  return { id: e.id, ts: e.ts, actor: e.actor, event: e.event, tier: e.tier, details: e.details, prevHash: e.prevHash, hash: e.hash };
}
