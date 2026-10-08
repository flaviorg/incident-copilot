// Status do incidente derivado do blackboard e das aprovações (spec 4.5.2). Puro.
// Recebe os status efetivos já projetados com effectiveStatus (aprovação vencida conta como expired).
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
