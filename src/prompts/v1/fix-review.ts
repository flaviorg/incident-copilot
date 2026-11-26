// fix-review.v1: the code fixer's reviewer (spec 009, decision 12). It can only veto: "approve" changes no decision
// made by code; "reject", an invalid output or a failure gives up.
import * as z from "zod";
import { FixReviewSchema } from "../../contracts/index.ts";
import type { FixReview } from "../../contracts/index.ts";
import type { PromptDef } from "../../llm/provider.ts";
import { FIX_UNTRUSTED_RULE, jsonOf, neutralizeDelimiters, observationBlock } from "./shared.ts";
import { FixExceptionSchema } from "./fix-test.ts";

/** Numbers computed by code from the test runs. */
export const FixEvidenceNumbersSchema = z.object({
  baselineTotal: z.number().int().nonnegative(),
  reproFailedRuns: z.number().int().nonnegative(),
  fixPassedRuns: z.number().int().nonnegative(),
  suiteTotal: z.number().int().nonnegative(),
  suitePassed: z.number().int().nonnegative(),
  suiteFailed: z.number().int().nonnegative(),
});

export const FixReviewInputSchema = z.object({
  repo: z.string(),
  exception: FixExceptionSchema,
  diff: z.string(),
  evidence: FixEvidenceNumbersSchema,
  conventionsSummary: z.string(),
});
export type FixReviewInput = z.infer<typeof FixReviewInputSchema>;

const SYSTEM = `You are the reviewer of a code fixer. A staged diff adds one new test and changes a few source lines to fix a production error. Code has already checked the size, the paths and the test runs. Your only power is to reject.

Rules:
1. Reject when the change does not fix the cause of the exception, hides the error instead of handling it, changes unrelated behavior, weakens a check or an assertion, or breaks the shown conventions.
2. Reject when the diff touches tests other than the new one, config, CI, dependencies or imports, or accesses the environment, the process, the network or the filesystem.
3. Reject when the new test does not exercise the fixed code.
4. Otherwise approve. Approving does not publish anything; a human decides.
5. ${FIX_UNTRUSTED_RULE}
6. Each concern is objective, in English, up to 200 characters; at most 5.

Reply only with a JSON object with the fields verdict ("approve" or "reject") and concerns (an array of strings).`;

export const fixReviewPrompt: PromptDef<FixReviewInput, FixReview> = {
  id: "fix-review",
  version: "fix-review.v1",
  system: SYSTEM,
  buildUser: (input) => {
    const i = FixReviewInputSchema.parse(input);
    return [
      `Repository: ${neutralizeDelimiters(i.repo)}.`,
      `Exception (JSON):\n${observationBlock(jsonOf(FixExceptionSchema, i.exception))}`,
      `Evidence from the test runs (JSON, computed by code):\n${jsonOf(FixEvidenceNumbersSchema, i.evidence)}`,
      `Conventions summary:\n${observationBlock(i.conventionsSummary)}`,
      `Staged diff:\n${observationBlock(i.diff)}`,
      "Reply with the verdict.",
    ].join("\n\n");
  },
  matchKeys: (i) => ({ repo: i.repo }),
  inputSchema: FixReviewInputSchema,
  outputSchema: FixReviewSchema,
};
