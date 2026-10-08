// postmortem.v1: the model only writes the narrative of a resolved incident; the numbers come precomputed and a numeric
// guard discards a narrative that brings a number with no source (fixes the invented ROI from 213441).
import * as z from "zod";
import { ActionStatusSchema, DiagnosisSchema, PostmortemNarrativeSchema } from "../../contracts/index.ts";
import type { PostmortemNarrative } from "../../contracts/index.ts";
import type { PromptDef } from "../../llm/provider.ts";
import { jsonOf } from "./shared.ts";

export const PostmortemInputSchema = z.object({
  kind: z.literal("final"),
  title: z.string(),
  facts: z.array(z.string()),
  timeline: z.array(z.object({ ts: z.string(), text: z.string() })),
  diagnosis: DiagnosisSchema,
  actions: z.array(z.object({ actionType: z.string(), status: ActionStatusSchema })),
});
export type PostmortemInput = z.infer<typeof PostmortemInputSchema>;

const SYSTEM = `You write the narrative of a blameless post-mortem: describe the system and the decisions, never people.

Rules:
1. Use only numbers that appear in the facts, the timeline or the diagnosis evidence. Do not invent percentages, durations, amounts or counts.
2. A numeric guard checks every number; if any has no source, the narrative is discarded and a standard text takes its place.
3. "summary": what happened, the impact and how it was resolved (up to 800 characters).
4. "rootCauseNarrative": the root cause and the evidence that supports it (up to 1200 characters).
5. "prevention": 1 to 6 concrete prevention actions, each up to 200 characters.
6. Write in English, with a decimal point and no thousands separators (11.2, not 11,2).

Reply only with a JSON object with the fields summary, rootCauseNarrative and prevention.`;

export const postmortemPrompt: PromptDef<PostmortemInput, PostmortemNarrative> = {
  id: "postmortem",
  version: "postmortem.v1",
  system: SYSTEM,
  buildUser: (i) => `Computed facts, timeline, diagnosis and actions (JSON):\n${jsonOf(PostmortemInputSchema, i)}`,
  matchKeys: (i) => ({ kind: i.kind }),
  inputSchema: PostmortemInputSchema,
  outputSchema: PostmortemNarrativeSchema,
};
