// Call recording (spec 6.9): each logical LLM call becomes a row in llm_calls, with success or the error type,
// and advances the simulated clock (spec 7.5: 20 s per call). A fixture error is not a model call: it propagates unrecorded.
import type { SqliteIncidentStore } from "../infra/db/incident-store.ts";
import type { Clock } from "../infra/clock.ts";
import type { LlmProvider, LlmResult, PromptDef, RunContext } from "./provider.ts";

export const LLM_CALL_TICK_SEC = 20;

export function withCallRecording(
  p: LlmProvider,
  d: { store: Pick<SqliteIncidentStore, "recordLlmCall">; clock: Clock; tickSec: number },
): LlmProvider {
  return {
    name: p.name,
    async generate<I, O>(prompt: PromptDef<I, O>, input: I, ctx: RunContext): Promise<LlmResult<O>> {
      const started = Date.now();
      const r = await p.generate(prompt, input, ctx);
      d.clock.tick(d.tickSec);
      d.store.recordLlmCall({
        incidentId: ctx.incidentId,
        runId: ctx.runId,
        promptVersion: prompt.version,
        model: r.success ? r.model : (r.model ?? p.name),
        // A failure may still carry billed usage (invalid outputs, summed by `resilient`).
        promptTokens: r.usage?.promptTokens ?? 0,
        completionTokens: r.usage?.completionTokens ?? 0,
        costUsd: r.usage?.costUsd ?? 0,
        latencyMs: r.success ? r.latencyMs : Math.max(0, Date.now() - started),
        success: r.success,
        errorKind: r.success ? null : r.error.kind,
        attempts: r.attempts ?? 1,
        usedFallback: r.usedFallback ?? false,
        usageEstimated: r.usage?.estimated === true,
        ts: d.clock.now().toISOString(),
      });
      return r;
    },
  };
}
