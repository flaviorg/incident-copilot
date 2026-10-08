// Timeout por chamada, retry e fallback (spec 6.2 e aula 221524). Falha de modelo é valor; exceção (erro de fixture) sobe.
import { llmFailure } from "./provider.ts";
import type { LlmProvider, LlmResult, PromptDef, RunContext } from "./provider.ts";

export type Attempt<O> = (signal: AbortSignal) => Promise<LlmResult<O>>;

/**
 * Estouro do prazo vira `{ kind: "timeout" }`; pai abortado vira `{ kind: "aborted" }`.
 * Resolve mesmo se o attempt ignorar o sinal (corrida com o aborto).
 */
export async function withTimeout<O>(a: Attempt<O>, ms: number, parent: AbortSignal): Promise<LlmResult<O>> {
  if (parent.aborted) return llmFailure("aborted", "run aborted before the call");
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort(new DOMException(`call exceeded ${ms} ms`, "TimeoutError"));
  }, ms);
  const onParentAbort = () => ctrl.abort(parent.reason);
  parent.addEventListener("abort", onParentAbort, { once: true });
  const timeoutResult = () => llmFailure("timeout", `LLM call exceeded ${ms} ms`);
  const abortedResult = () => llmFailure("aborted", "run aborted during the call");
  try {
    const attempt = a(ctrl.signal);
    attempt.catch(() => {}); // evita rejeição não tratada se o aborto vencer a corrida; a corrida ainda vê a rejeição
    const onAbort = new Promise<LlmResult<O>>((resolve) => {
      ctrl.signal.addEventListener("abort", () => resolve(timedOut ? timeoutResult() : abortedResult()), { once: true });
    });
    const r = await Promise.race([attempt, onAbort]);
    if (!r.success && r.error.kind === "aborted" && timedOut) return timeoutResult();
    return r;
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", onParentAbort);
  }
}

/** Até `attempts` tentativas; devolve o primeiro sucesso ou a última falha. Não repete "aborted". */
export async function withRetry<O>(run: () => Promise<LlmResult<O>>, attempts: number): Promise<LlmResult<O>> {
  let last: LlmResult<O> = llmFailure("server_error", "no attempt made");
  for (let i = 0; i < Math.max(1, attempts); i++) {
    last = await run();
    if (last.success || last.error.kind === "aborted") return last;
  }
  return last;
}

/** 2 tentativas no principal (cada uma com timeout) e, se houver, 1 no fallback. */
export function resilient(primary: LlmProvider, o: { fallback: LlmProvider | null; attempts: 2; timeoutMs: number }): LlmProvider {
  const once = <I, O>(p: LlmProvider, prompt: PromptDef<I, O>, input: I, ctx: RunContext) => () =>
    withTimeout<O>((signal) => p.generate(prompt, input, { ...ctx, signal }), o.timeoutMs, ctx.signal);
  return {
    name: primary.name,
    async generate<I, O>(prompt: PromptDef<I, O>, input: I, ctx: RunContext): Promise<LlmResult<O>> {
      const r = await withRetry(once(primary, prompt, input, ctx), o.attempts);
      if (r.success || r.error.kind === "aborted" || !o.fallback) return r;
      return once(o.fallback, prompt, input, ctx)();
    },
  };
}
