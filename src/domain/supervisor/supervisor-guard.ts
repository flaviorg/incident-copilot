// Supervisor guard (spec 6.3): the LLM chooses, the code validates the preconditions. Pure.
// An invalid choice becomes a critique and follows the canonical route: the first missing artifact in the order
// diagnosis, runbooks, audited plan, gate, report.
import type { Blackboard, EscalationReason, Limits, SupervisorDecision } from "../../contracts/index.ts";

export type SupervisorTarget = "telemetry_analyst" | "runbook_retriever" | "remediation_planner" | "gate" | "reporter";

const confident = (bb: Blackboard) => bb.diagnosis !== null && (bb.diagnosis.confidence === "medium" || bb.diagnosis.confidence === "high");

/** No diagnosis, or a weak diagnosis with no ReAct cap and with rounds left. */
const needsTelemetry = (bb: Blackboard, limits: Limits) =>
  bb.diagnosis === null || (bb.diagnosis.confidence === "low" && !bb.diagnosis.capReached && bb.telemetryRuns < limits.maxTelemetryRuns);

/**
 * Called with `supervisor.iterations` already incremented, before the LLM. Order from spec 6.3:
 * team cap, ReAct cap, weak diagnosis after the allowed rounds.
 */
export function preEscalation(bb: Blackboard, limits: Limits): { reason: EscalationReason; detail: string } | null {
  if (bb.supervisor.iterations > limits.teamMaxIterations) {
    return { reason: "team_cap_reached", detail: `supervisor invoked ${bb.supervisor.iterations} times; the team cap is ${limits.teamMaxIterations}` };
  }
  if (bb.diagnosis?.capReached) {
    return { reason: "react_cap_low_confidence", detail: `the analyst reached the cap of ${limits.reactMaxSteps} steps without a conclusion` };
  }
  if (bb.diagnosis?.confidence === "low" && bb.telemetryRuns >= limits.maxTelemetryRuns) {
    return { reason: "low_confidence_diagnosis", detail: `diagnosis still at low confidence after ${bb.telemetryRuns} analyst rounds` };
  }
  return null;
}

/** Reason for the refusal, or null if the precondition holds (table from spec 6.3). */
function violation(target: SupervisorTarget, bb: Blackboard, limits: Limits): string | null {
  switch (target) {
    case "telemetry_analyst":
      if (needsTelemetry(bb, limits)) return null;
      if (bb.diagnosis?.capReached) return "the analyst already reached the step cap";
      if (bb.diagnosis?.confidence === "low") return `the analyst already ran ${bb.telemetryRuns} times, the maximum allowed`;
      return "a diagnosis with medium or high confidence already exists";
    case "runbook_retriever":
      if (!confident(bb)) return "missing a diagnosis with medium or high confidence";
      if (bb.runbookSearchDone) return "the runbook search was already done and is not repeated";
      return null;
    case "remediation_planner":
      if (!confident(bb)) return "missing a diagnosis with medium or high confidence";
      if (!bb.runbookSearchDone) return "the runbook search has not been done yet";
      if (bb.plan !== null) return "a plan already exists";
      return null;
    case "gate":
      if (bb.plan === null) return "there is no plan";
      if (bb.audit === null) return "the plan has not been audited yet";
      if (bb.actions.length > 0) return "the remediation gate already processed this plan";
      return null;
    case "reporter":
      if (bb.verification?.healthy === true || bb.escalation !== null) return null;
      return "recovery has not been verified yet";
  }
}

export function canonicalNext(bb: Blackboard, limits: Limits): SupervisorTarget {
  if (needsTelemetry(bb, limits)) return "telemetry_analyst";
  if (!bb.runbookSearchDone) return "runbook_retriever";
  if (bb.plan === null || bb.audit === null) return "remediation_planner";
  if (bb.actions.length === 0) return "gate";
  return "reporter";
}

/** `done` becomes `reporter` and is validated as such. */
export function guardChoice(choice: SupervisorDecision["next"], bb: Blackboard, limits: Limits): { next: SupervisorTarget; coerced: boolean; reason: string } {
  const target: SupervisorTarget = choice === "done" ? "reporter" : choice;
  const why = violation(target, bb, limits);
  if (why === null) return { next: target, coerced: false, reason: "" };
  return { next: canonicalNext(bb, limits), coerced: true, reason: why };
}
