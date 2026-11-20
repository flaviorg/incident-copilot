// Contract of the LLM provider (spec 4.3): validated structured output for a versioned prompt, with measured usage.
// Knows no business rules. A model failure is a value (LlmResult), never an exception; an exception is only a repository defect
// (UnscriptedLlmCallError, FixturePromptDriftError), which propagates up to the test or the CLI.
import type * as z from "zod";
import type { LlmErrorKind } from "../contracts/index.ts";

export type { LlmErrorKind };

export interface PromptDef<I, O> {
  id: string; // "planner"
  version: string; // "planner.v1"
  system: string; // system prompt text (goes into the fixture hash)
  buildUser(input: I): string; // only the necessary fields (200963)
  matchKeys(input: I): Record<string, string | number | boolean>; // small, stable key for the fake
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
}

export interface RunContext {
  incidentId: string;
  runId: string;
  scenarioId: string;
  requestId: string | null;
  signal: AbortSignal;
}

/** `estimated`: the provider reported no usage, so the tokens come from estimateTokens (about 4 characters per token). */
export type LlmUsage = { promptTokens: number; completionTokens: number; costUsd: number; estimated?: boolean };

/**
 * `retryable: false` (a 4xx such as 400 or 404) skips the retry on the same model; `fallbackUseful: false` (401, 402,
 * 403: the fallback uses the same key) also skips the fallback. `retryAfterMs` comes from a Retry-After header.
 */
export type LlmError = { kind: LlmErrorKind; message: string; retryable?: boolean; fallbackUseful?: boolean; retryAfterMs?: number };

/** Set by `resilient` on the logical call: how many attempts ran and whether the fallback model answered. */
export type AttemptInfo = { attempts?: number; usedFallback?: boolean };

/**
 * `model` on the failure is optional: only call recording uses it, when the provider knows which model failed. A failure may
 * carry `usage` too (an invalid output was still billed).
 */
export type LlmResult<O> =
  | ({ success: true; data: O; usage: LlmUsage; model: string; latencyMs: number } & AttemptInfo)
  | ({ success: false; error: LlmError; model?: string; usage?: LlmUsage } & AttemptInfo);

export interface LlmProvider {
  readonly name: "fake" | "openrouter";
  generate<I, O>(prompt: PromptDef<I, O>, input: I, ctx: RunContext): Promise<LlmResult<O>>;
}

export type FailureExtra = Omit<LlmError, "kind" | "message"> & { usage?: LlmUsage };

export function llmFailure(
  kind: LlmErrorKind, message: string, model?: string, extra: FailureExtra = {},
): { success: false; error: LlmError; model?: string; usage?: LlmUsage } {
  const { usage, ...flags } = extra;
  return {
    success: false,
    error: { kind, message, ...flags },
    ...(model === undefined ? {} : { model }),
    ...(usage === undefined ? {} : { usage }),
  };
}
