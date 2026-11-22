// fix-patch.v1: the code fixer's patch author (spec 009, decision 8). It never sees the test: it gets the exception,
// the frames, the anchor window, the conventions and the observed failure facts, and proposes search/replace edits.
import * as z from "zod";
import { FixPatchProposalSchema, StackFrameSchema } from "../../contracts/index.ts";
import type { FixPatchProposal } from "../../contracts/index.ts";
import type { PromptDef } from "../../llm/provider.ts";
import { FIX_UNTRUSTED_RULE, neutralizeDelimiters } from "./shared.ts";
import {
  eventBlock, failureSection, feedbackSection, filesSection,
  FixAnchorWindowSchema, FixExceptionSchema, FixFailureFactsSchema, FixRepoFileSchema,
} from "./fix-test.ts";

/** No field carries the test: the patch author cannot fit the fix to it. */
export const FixPatchInputSchema = z.object({
  repo: z.string(),
  attempt: z.number().int().min(1),
  exception: FixExceptionSchema,
  frames: z.array(StackFrameSchema),
  anchor: StackFrameSchema,
  anchorWindow: FixAnchorWindowSchema,
  conventions: z.array(FixRepoFileSchema),
  failure: FixFailureFactsSchema,
  feedback: z.array(z.string()),
});
export type FixPatchInput = z.infer<typeof FixPatchInputSchema>;

const SYSTEM = `You are the patch author of a code fixer. An error happened in production after a deploy, and a new test already reproduces it. You do not see the test. Propose the smallest change to the source code that fixes the cause of the error.

Rules:
1. Make the smallest change that fixes the cause, in the anchor file or another file of the shown frames, close to the anchor line. Do not refactor, rename or reformat.
2. Each edit is {"path", "search", "replace"}: "search" is exact text copied from the shown file and must occur exactly once in it. At most 2 edits.
3. Never edit tests, config, CI, dependencies or imports. Do not add imports, and do not remove assertions or error handling.
4. The fixed code must not access the environment, the process, the network or the filesystem, and must not log, spawn or evaluate code.
5. Follow the shown conventions (style, error handling, naming).
6. ${FIX_UNTRUSTED_RULE}
7. Write "rationale" in English, up to 600 characters: the cause and why the change fixes it.

Reply only with a JSON object with the fields edits (an array of {"path", "search", "replace"}) and rationale.`;

export const fixPatchPrompt: PromptDef<FixPatchInput, FixPatchProposal> = {
  id: "fix-patch",
  version: "fix-patch.v1",
  system: SYSTEM,
  buildUser: (input) => {
    const i = FixPatchInputSchema.parse(input);
    return [
      `Repository: ${neutralizeDelimiters(i.repo)}. Attempt ${i.attempt}.`,
      eventBlock(i),
      filesSection(i.anchorWindow, i.conventions),
      failureSection("How the new test fails today", i.failure),
      feedbackSection(i.feedback),
      "Reply with the edits.",
    ].join("\n\n");
  },
  matchKeys: (i) => ({ repo: i.repo, attempt: i.attempt }),
  inputSchema: FixPatchInputSchema,
  outputSchema: FixPatchProposalSchema,
};
