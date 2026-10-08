// Valida, redige e persiste eventos de trace com numeração sequencial por incidente (spec 4.2). Não decide fluxo.
import { TraceEventSchema } from "../contracts/index.ts";
import type { AgentId, TraceEvent } from "../contracts/index.ts";
import type { SqliteIncidentStore } from "../infra/db/incident-store.ts";
import type { Ids } from "../infra/ids.ts";
import type { Clock } from "../infra/clock.ts";
import { redactSecrets } from "../infra/redact.ts";
import type { LlmResult, PromptDef, RunContext } from "../llm/provider.ts";

export type TraceInput = { [K in TraceEvent["type"]]: { type: K; payload: Extract<TraceEvent, { type: K }>["payload"] } }[TraceEvent["type"]];
export type TraceLlmInfo = NonNullable<TraceEvent["llm"]>;

/** Teto de cada texto dentro de `args` de um evento action (o maior parâmetro do catálogo, a nota, tem 500). */
export const TRACE_ARG_MAX_CHARS = 500;

/** Corta no máximo do schema com reticências. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/** Uso do LLM que acompanha o evento produzido a partir de uma resposta bem-sucedida. */
export function llmInfoOf<I, O>(prompt: PromptDef<I, O>, r: LlmResult<O>): TraceLlmInfo | null {
  if (!r.success) return null;
  return {
    model: r.model,
    promptVersion: prompt.version,
    promptTokens: r.usage.promptTokens,
    completionTokens: r.usage.completionTokens,
    costUsd: r.usage.costUsd,
    latencyMs: Math.round(r.latencyMs),
  };
}

/** Corta cada texto dentro de `args`, em qualquer nível, sem mudar a forma (números, booleanos e null ficam). */
function clipArgs(v: unknown): unknown {
  if (typeof v === "string") return clip(v, TRACE_ARG_MAX_CHARS);
  if (Array.isArray(v)) return v.map(clipArgs);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipArgs(x)]));
  return v;
}

function clipPayload(i: TraceInput): TraceInput {
  switch (i.type) {
    case "action":
      return { type: i.type, payload: { ...i.payload, args: clipArgs(i.payload.args) as Record<string, unknown> } };
    case "thought":
      return { type: i.type, payload: { text: clip(i.payload.text, 1000) } };
    case "observation":
      return { type: i.type, payload: { ...i.payload, summary: clip(i.payload.summary, 600) } };
    case "critique":
      return { type: i.type, payload: { ...i.payload, feedback: clip(i.payload.feedback, 600) } };
    case "answer":
      return { type: i.type, payload: { ...i.payload, text: clip(i.payload.text, 2000) } };
    case "handoff":
      return { type: i.type, payload: { ...i.payload, brief: clip(i.payload.brief, 400), reason: clip(i.payload.reason, 400) } };
    default:
      return i;
  }
}

export class TraceSink {
  private readonly store: SqliteIncidentStore;
  private readonly ids: Ids;
  private readonly clock: Clock;
  private readonly secrets: readonly string[];

  constructor(d: { store: SqliteIncidentStore; ids: Ids; clock: Clock; secrets: readonly string[] }) {
    this.store = d.store;
    this.ids = d.ids;
    this.clock = d.clock;
    this.secrets = d.secrets;
  }

  /** Redige antes de cortar (o marcador pode ser maior que o segredo), valida com Zod e grava com seq = nextTraceSeq. */
  emit(ctx: RunContext, agent: AgentId, input: TraceInput, llm: TraceLlmInfo | null = null): TraceEvent {
    const payload = clipPayload(redactSecrets(input, this.secrets));
    const seq = this.store.nextTraceSeq(ctx.incidentId);
    const event = TraceEventSchema.parse({
      id: this.ids.event(ctx.incidentId, seq),
      incidentId: ctx.incidentId,
      runId: ctx.runId,
      requestId: ctx.requestId === null ? null : redactSecrets(ctx.requestId, this.secrets),
      seq,
      ts: this.clock.now().toISOString(),
      agent,
      type: payload.type,
      payload: payload.payload,
      llm,
    });
    this.store.appendTrace([event]);
    return event;
  }
}
