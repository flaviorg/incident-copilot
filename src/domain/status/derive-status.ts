// Incident status derived from the blackboard and the approvals (spec 4.5.2). Pure.
// Takes the effective statuses already projected with effectiveStatus (an overdue approval counts as expired).
import type { ApprovalStatus, Blackboard, IncidentStatus } from "../../contracts/index.ts";

const MITIGATING_PHASES: readonly Blackboard["phase"][] = ["executing", "verifying", "resume"];

export function deriveIncidentStatus(bb: Blackboard, effectiveApprovalStatuses: ApprovalStatus[]): IncidentStatus {
  if (bb.escalation !== null) return "escalated";
  if (bb.postmortem?.status === "final") return "resolved";
  if (effectiveApprovalStatuses.includes("pending")) return "awaiting_approval";
  if (MITIGATING_PHASES.includes(bb.phase)) return "mitigating";
  if (bb.phase === "new") return "open";
  return "investigating";
}
