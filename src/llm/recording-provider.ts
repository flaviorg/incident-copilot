// Registro de chamadas (spec 6.9): cada chamada lógica de LLM vira linha em llm_calls, com sucesso ou tipo de erro,
// e avança o relógio simulado (spec 7.5: 20 s por chamada). Erro de fixture não é chamada de modelo: sobe sem registro.
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
        promptTokens: r.success ? r.usage.promptTokens : 0,
        completionTokens: r.success ? r.usage.completionTokens : 0,
        costUsd: r.success ? r.usage.costUsd : 0,
        latencyMs: r.success ? r.latencyMs : Math.max(0, Date.now() - started),
        success: r.success,
        errorKind: r.success ? null : r.error.kind,
        ts: d.clock.now().toISOString(),
      });
      return r;
    },
  };
}
