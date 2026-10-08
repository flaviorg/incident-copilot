// Máquina de estados da aprovação (spec 6.5). Pura: transição tipada, projeção de expiração sem gravar nada.
import type { Approval, ApprovalStatus } from "../../contracts/index.ts";
import { ApprovalTransitionError } from "../errors.ts";

export type ApprovalEvent =
  | { type: "approve" | "reject"; approver: string; comment: string | null; source: "structured" | "text" }
  | { type: "expire" };

/** Pendente e já passou de expiresAt. */
export function isExpired(a: Approval, now: Date): boolean {
  return a.status === "pending" && now.getTime() > Date.parse(a.expiresAt);
}

/** Projeta "expired" para leitura sem alterar o objeto nem gravar nada. */
export function effectiveStatus(a: Approval, now: Date): ApprovalStatus {
  return isExpired(a, now) ? "expired" : a.status;
}

/**
 * pending -> approved | rejected (antes de expiresAt) | expired. De qualquer outro estado, `not_pending`; decisão
 * depois do prazo, `expired`. Devolve um objeto novo com version + 1 e decidedAt = now; o erro é devolvido, não lançado.
 */
export function transition(a: Approval, ev: ApprovalEvent, now: Date): Approval | ApprovalTransitionError {
  if (a.status !== "pending") return new ApprovalTransitionError("not_pending");
  const decidedAt = now.toISOString();
  if (ev.type === "expire") {
    return { ...a, status: "expired", decidedAt, approver: null, comment: null, decisionSource: "expiry", version: a.version + 1 };
  }
  if (isExpired(a, now)) return new ApprovalTransitionError("expired");
  return {
    ...a,
    status: ev.type === "approve" ? "approved" : "rejected",
    decidedAt,
    approver: ev.approver,
    comment: ev.comment,
    decisionSource: ev.source,
    version: a.version + 1,
  };
}
