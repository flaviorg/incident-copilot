// Contrato do provedor de LLM (spec 4.3): saída estruturada validada para um prompt versionado, com uso medido.
// Não conhece regra de negócio. Falha de modelo é valor (LlmResult), nunca exceção; exceção é só defeito do repositório
// (UnscriptedLlmCallError, FixturePromptDriftError), que sobe até o teste ou a CLI.
import type * as z from "zod";
import type { LlmErrorKind } from "../contracts/index.ts";

export type { LlmErrorKind };

export interface PromptDef<I, O> {
  id: string; // "planner"
  version: string; // "planner.v1"
  system: string; // texto do system prompt (entra no hash da fixture)
  buildUser(input: I): string; // só os campos necessários (200963)
  matchKeys(input: I): Record<string, string | number | boolean>; // chave pequena e estável para o fake
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

export type LlmUsage = { promptTokens: number; completionTokens: number; costUsd: number };
export type LlmError = { kind: LlmErrorKind; message: string };

/** `model` na falha é opcional: só o registro de chamadas usa, quando o provedor sabe qual modelo falhou. */
export type LlmResult<O> =
  | { success: true; data: O; usage: LlmUsage; model: string; latencyMs: number }
  | { success: false; error: LlmError; model?: string };

export interface LlmProvider {
  readonly name: "fake" | "openrouter";
  generate<I, O>(prompt: PromptDef<I, O>, input: I, ctx: RunContext): Promise<LlmResult<O>>;
}

export function llmFailure(kind: LlmErrorKind, message: string, model?: string): { success: false; error: LlmError; model?: string } {
  return model === undefined ? { success: false, error: { kind, message } } : { success: false, error: { kind, message }, model };
}
