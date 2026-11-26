// fix_finalize (spec 009, decisions 13, 15 and 21; AC-73, AC-80): the last deterministic gate before `patch_ready`.
// `injectionScan` over every model output (test, edits, rationales, review concerns) gives up on a hit. The patch hash is
// the injected `sha256` over `canonicalPatchPayload`, the same string the publisher re-hashes. `classifyAction` with
// `proposer: "code_fixer"` must give exactly tier 3 with valid params, else `catalog_refused`. No LLM, no code host.
import type { CodeFixReason } from "../../../contracts/index.ts";
import { classifyAction } from "../../../domain/autonomy/catalog.ts";
import { injectionScan } from "../../../domain/code-fix/injection-scan.ts";
import { canonicalPatchPayload } from "../../../domain/code-fix/patch-payload.ts";
import { attemptAborted } from "../state.ts";
import type { CodeFixNodeFn, CodeFixState } from "../state.ts";

export type FixFinalizeDeps = {
  /** Hex SHA-256 of the UTF-8 text (node:crypto in the app layer). */
  sha256: (text: string) => string;
  now: () => Date;
  /** The catalog classifier; tests may wrap it. Defaults to `classifyAction`. */
  classify?: typeof classifyAction;
};

export const DRAFT_PR_ACTION = "open_draft_pull_request";

/** Every text the model wrote that is part of the artifact or the report. */
function modelTexts(s: CodeFixState): string[] {
  return [
    ...(s.testProposal ? [s.testProposal.test.path, s.testProposal.test.content, s.testProposal.rationale] : []),
    ...(s.patchProposal ? [s.patchProposal.rationale, ...s.patchProposal.edits.flatMap((e) => [e.path, e.replace])] : []),
    ...(s.review ? s.review.concerns : []),
  ];
}

export function createFixFinalizeNode(d: FixFinalizeDeps): CodeFixNodeFn {
  const classify = d.classify ?? classifyAction;
  return async (state, config) => {
    const fail = (failure: CodeFixReason, extra: Partial<CodeFixState> = {}): Partial<CodeFixState> => ({ stage: "finalize", failure, ...extra });
    if (attemptAborted(config)) return fail("attempt_timeout");
    const repo = state.repository;
    if (repo === null || state.patch === null || state.files.length === 0) return fail("catalog_refused");
    if (state.review?.verdict !== "approve") return fail(state.review === null ? "reviewer_unavailable" : "reviewer_rejected");

    if (modelTexts(state).some((t) => injectionScan(t).hit)) return fail("guard_rejected", { violations: ["injection_text"] });

    const patchSha256 = d.sha256(canonicalPatchPayload(state.patch, state.files));
    const cls = classify(
      { actionType: DRAFT_PR_ACTION, target: `repository/${repo.service}`, params: { attemptId: state.attemptId, patchSha256 }, runbookRef: null },
      {
        scope: { service: repo.service, account: null, incidentId: state.incidentId },
        revisionsExhausted: false,
        knownRunbookRefs: new Set<string>(),
        proposer: "code_fixer",
      },
    );
    if (cls.tier !== 3 || !cls.known || !cls.executable || !cls.paramsOk) return fail("catalog_refused");

    return {
      stage: "finalize",
      failure: null,
      violations: [],
      patchSha256,
      patchReadyAt: d.now().toISOString(),
      outcome: { status: "patch_ready", reason: null },
    };
  };
}
