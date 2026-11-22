// fix_give_up (spec 009, decisions 4, 5, 8 and 17; AC-61, AC-69, AC-81): writes the end of a failed attempt. Before the
// workspace (eligibility, locate) a skip reason is `skipped`; anything else is `gave_up`. After locate, when the anchor is
// known, it attaches a suggestion built from facts; the model's rationale is kept only as redacted, clipped text.
import type { CodeFixStage } from "../../../contracts/index.ts";
import { isSkipReason } from "../../../domain/code-fix/reasons.ts";
import { buildSuggestion } from "../../../domain/code-fix/suggestion.ts";
import { giveUpReason } from "../routing.ts";
import type { FixRouteLimits } from "../routing.ts";
import type { CodeFixNodeFn } from "../state.ts";

export type FixGiveUpDeps = {
  limits: FixRouteLimits;
  /** `redactSecrets` bound to the known secrets. */
  redact: (text: string) => string;
};

const BEFORE_WORKSPACE: readonly CodeFixStage[] = ["eligibility", "locate"];

export function createFixGiveUpNode(d: FixGiveUpDeps): CodeFixNodeFn {
  return async (state) => {
    const reason = giveUpReason(state, d.limits);
    const skipped = BEFORE_WORKSPACE.includes(state.stage) && isSkipReason(reason);
    if (skipped) return { failure: reason, outcome: { status: "skipped", reason }, suggestion: null };
    const rationale = state.patchProposal?.rationale ?? state.testProposal?.rationale ?? null;
    const suggestion = state.anchor === null
      ? null
      : buildSuggestion(
        { anchor: state.anchor, exception: state.exception === null ? null : { type: state.exception.type, value: d.redact(state.exception.value) } },
        reason,
        rationale === null ? null : d.redact(rationale),
      );
    return { failure: reason, outcome: { status: "gave_up", reason }, suggestion };
  };
}
