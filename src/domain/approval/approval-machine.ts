// Approval state machine (spec 6.5). Pure: typed transition, expiration projection without writing anything.
import type { Approval, ApprovalStatus } from "../../contracts/index.ts";
import { ApprovalTransitionError } from "../errors.ts";

export type ApprovalEvent =
  | { type: "approve" | "reject"; approver: string; comment: string | null; source: "structured" | "text" }
  | { type: "expire" };

/** Pending and already past expiresAt. */
export function isExpired(a: Approval, now: Date): boolean {
  return a.status === "pending" && now.getTime() > Date.parse(a.expiresAt);
}

/** Projects "expired" for reading without changing the object or writing anything. */
export function effectiveStatus(a: Approval, now: Date): ApprovalStatus {
  return isExpired(a, now) ? "expired" : a.status;
}

/**
 * pending -> approved | rejected (before expiresAt) | expired. From any other state, `not_pending`; a decision
 * after the deadline, `expired`. Returns a new object with version + 1 and decidedAt = now; the error is returned, not thrown.
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
