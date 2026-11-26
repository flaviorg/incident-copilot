// Versioned v1 prompts (198069, 198082, 200963): a prompt is versioned configuration; the hash of version + system lives in the fixtures.
import type { PromptDef } from "../../llm/provider.ts";
import { supervisorPrompt } from "./supervisor.ts";
import { telemetryReactPrompt } from "./telemetry-react.ts";
import { plannerPrompt } from "./planner.ts";
import { auditorPrompt } from "./auditor.ts";
import { postmortemPrompt } from "./postmortem.ts";
import { fixTestPrompt } from "./fix-test.ts";
import { fixPatchPrompt } from "./fix-patch.ts";
import { fixReviewPrompt } from "./fix-review.ts";

export { supervisorPrompt, SupervisorInputSchema } from "./supervisor.ts";
export type { SupervisorInput } from "./supervisor.ts";
export { telemetryReactPrompt, TelemetryReactInputSchema, OBSERVATION_OPEN, OBSERVATION_CLOSE } from "./telemetry-react.ts";
export type { TelemetryReactInput } from "./telemetry-react.ts";
export { plannerPrompt, PlannerInputSchema } from "./planner.ts";
export type { PlannerInput } from "./planner.ts";
export { auditorPrompt, AuditorInputSchema } from "./auditor.ts";
export type { AuditorInput } from "./auditor.ts";
export { postmortemPrompt, PostmortemInputSchema } from "./postmortem.ts";
export type { PostmortemInput } from "./postmortem.ts";
export { fixTestPrompt, FixTestInputSchema } from "./fix-test.ts";
export type { FixTestInput } from "./fix-test.ts";
export { fixPatchPrompt, FixPatchInputSchema } from "./fix-patch.ts";
export type { FixPatchInput } from "./fix-patch.ts";
export { fixReviewPrompt, FixReviewInputSchema, FixEvidenceNumbersSchema } from "./fix-review.ts";
export type { FixReviewInput } from "./fix-review.ts";

export const ALL_PROMPTS: PromptDef<any, any>[] = [supervisorPrompt, telemetryReactPrompt, plannerPrompt, auditorPrompt, postmortemPrompt];

/**
 * The code fixer's prompts (spec 009, decision 18). Kept out of ALL_PROMPTS so the scenario fixtures, the demo
 * recordings' promptVersions and the prompt id list stay unchanged; `fixtures:rehash` writes their hashes only into
 * files that script one of them.
 */
export const FIX_PROMPTS: PromptDef<any, any>[] = [fixTestPrompt, fixPatchPrompt, fixReviewPrompt];
