// fix-test.v1: the code fixer's test author (spec 009, decision 8). It writes one new test that reproduces the
// incident's error; code then runs it and decides whether it fails for the right reason (decision 9).
import * as z from "zod";
import { FixTestProposalSchema, StackFrameSchema } from "../../contracts/index.ts";
import type { FixTestProposal } from "../../contracts/index.ts";
import type { PromptDef } from "../../llm/provider.ts";
import { FIX_UNTRUSTED_RULE, jsonOf, neutralizeDelimiters, observationBlock, repoFileBlock, testOutputBlock } from "./shared.ts";

// ---------- input pieces shared by the two authors ----------

export const FixExceptionSchema = z.object({ type: z.string(), value: z.string() });
export const FixRepoFileSchema = z.object({ path: z.string(), text: z.string() });
export const FixAnchorWindowSchema = z.object({ path: z.string(), startLine: z.number().int().positive(), text: z.string() });
/** Observed failure facts of the new test (name, errorName, frames); never its content and never raw output. */
export const FixFailureFactsSchema = z.object({
  name: z.string(),
  errorName: z.string(),
  frames: z.array(z.object({ file: z.string(), line: z.number().int().positive() })),
});

/** The exception and its frames, as the error tracker reported them. */
export const FixEventSchema = z.object({
  exception: FixExceptionSchema,
  frames: z.array(StackFrameSchema),
  anchor: StackFrameSchema,
});

export function eventBlock(i: z.infer<typeof FixEventSchema>): string {
  return `Error event (JSON):\n${observationBlock(jsonOf(FixEventSchema, i))}`;
}

export function filesSection(anchorWindow: z.infer<typeof FixAnchorWindowSchema>, conventions: z.infer<typeof FixRepoFileSchema>[]): string {
  const conv = conventions.length === 0 ? "(none)" : conventions.map((c) => repoFileBlock(c.path, c.text)).join("\n\n");
  return [
    `Anchor window (starts at line ${anchorWindow.startLine}):\n${repoFileBlock(anchorWindow.path, anchorWindow.text)}`,
    `Repository conventions:\n${conv}`,
  ].join("\n\n");
}

export function failureSection(title: string, f: z.infer<typeof FixFailureFactsSchema>): string {
  return `${title} (JSON):\n${testOutputBlock(jsonOf(FixFailureFactsSchema, f))}`;
}

export function feedbackSection(feedback: string[]): string {
  if (feedback.length === 0) return "Feedback from the previous attempt: (first attempt)";
  return `Feedback from the previous attempt (fix every point):\n${feedback.map((f) => `- ${neutralizeDelimiters(f).replace(/\s+/g, " ")}`).join("\n")}`;
}

export const FixTestInputSchema = z.object({
  repo: z.string(),
  attempt: z.number().int().min(1),
  exception: FixExceptionSchema,
  frames: z.array(StackFrameSchema),
  anchor: StackFrameSchema,
  anchorWindow: FixAnchorWindowSchema,
  conventions: z.array(FixRepoFileSchema),
  /** How the previous test failed, when code judged it the wrong reason. */
  observedFailure: FixFailureFactsSchema.optional(),
  /** Guard violation sentences from code. */
  feedback: z.array(z.string()),
});
export type FixTestInput = z.infer<typeof FixTestInputSchema>;

const SYSTEM = `You are the test author of a code fixer. An error happened in production after a deploy. Write exactly one new test that reproduces that error against the current code, so it fails now and will pass once the bug is fixed.

Rules:
1. Write one new test file at a new path that follows the repository's test file conventions. Never edit or replace an existing test.
2. The test imports the module of the anchor file by its relative path and calls the code that throws, so the failure comes from the anchor code, not from the test itself.
3. Use only node:test, node:assert or node:assert/strict, and relative imports of files that exist. Never edit tests, config, CI, dependencies or imports of the source code.
4. No environment, process, network or filesystem access, no timers, no dynamic imports, no skip, only or todo markers. Assert real behavior.
5. Follow the shown conventions (module format, naming, style). Keep it short.
6. ${FIX_UNTRUSTED_RULE}
7. Write "rationale" in English, up to 600 characters: what the test exercises and why it fails today.

Reply only with a JSON object with the fields test ({"path": "...", "content": "..."}) and rationale.`;

export const fixTestPrompt: PromptDef<FixTestInput, FixTestProposal> = {
  id: "fix-test",
  version: "fix-test.v1",
  system: SYSTEM,
  buildUser: (input) => {
    const i = FixTestInputSchema.parse(input);
    return [
      `Repository: ${neutralizeDelimiters(i.repo)}. Attempt ${i.attempt}.`,
      eventBlock(i),
      filesSection(i.anchorWindow, i.conventions),
      ...(i.observedFailure ? [failureSection("How the previous test failed", i.observedFailure)] : []),
      feedbackSection(i.feedback),
      "Reply with the new test.",
    ].join("\n\n");
  },
  matchKeys: (i) => ({ repo: i.repo, attempt: i.attempt }),
  inputSchema: FixTestInputSchema,
  outputSchema: FixTestProposalSchema,
};
