// fix_eligibility (spec 009, decision 4; AC-61): deterministic and deny by default. The input is built by the service from
// the persisted blackboard, the config and the store; the repository and error group come from code, never from a model.
// A failure is a skip reason: fix_give_up records it as `skipped`, with no LLM call, no git and no code-host request.
import { evaluateEligibility } from "../../../domain/code-fix/eligibility.ts";
import type { EligibilityInput } from "../../../domain/code-fix/eligibility.ts";
import type { CodeFixNodeFn, CodeFixRepoConfig, CodeFixState } from "../state.ts";

export type FixEligibilityDeps = {
  /** The allowlisted repositories of `codeFix.repositories`. */
  repositories: readonly CodeFixRepoConfig[];
  eligibilityInput: (state: CodeFixState) => EligibilityInput;
};

export function createFixEligibilityNode(d: FixEligibilityDeps): CodeFixNodeFn {
  return async (state) => {
    const r = evaluateEligibility(d.eligibilityInput(state));
    if (!r.eligible) return { stage: "eligibility", failure: r.reason };
    const repository = d.repositories.find((x) => x.repo === r.repository.repo && x.service === r.repository.service);
    // The eligibility input and the node's config disagree: fail closed.
    if (!repository) return { stage: "eligibility", failure: "service_not_allowlisted" };
    return {
      stage: "eligibility",
      failure: null,
      repository: structuredClone(repository),
      connectorId: r.repository.connector,
      errorGroupId: r.errorGroupId,
    };
  };
}
