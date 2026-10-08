// Versioned v1 prompts (198069, 198082, 200963): a prompt is versioned configuration; the hash of version + system lives in the fixtures.
import type { PromptDef } from "../../llm/provider.ts";
import { supervisorPrompt } from "./supervisor.ts";
import { telemetryReactPrompt } from "./telemetry-react.ts";
import { plannerPrompt } from "./planner.ts";
import { auditorPrompt } from "./auditor.ts";
import { postmortemPrompt } from "./postmortem.ts";

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

export const ALL_PROMPTS: PromptDef<any, any>[] = [supervisorPrompt, telemetryReactPrompt, plannerPrompt, auditorPrompt, postmortemPrompt];
