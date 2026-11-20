// Per-call timeout, retry and fallback (spec 6.2 and lesson 221524). A model failure is a value; an exception (fixture error) propagates.
import { llmFailure } from "./provider.ts";
import type { LlmProvider, LlmResult, LlmUsage, PromptDef, RunContext } from "./provider.ts";

export type Attempt<O> = (signal: AbortSignal) => Promise<LlmResult<O>>;

/**
 * Overrunning the deadline becomes `{ kind: "timeout" }`; an aborted parent becomes `{ kind: "aborted" }`.
 * Resolves even if the attempt ignores the signal (it races against the abort).
 */
export async function withTimeout<O>(a: Attempt<O>, ms: number, parent: AbortSignal, model?: string): Promise<LlmResult<O>> {
  if (parent.aborted) return llmFailure("aborted", "run aborted before the call", model);
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort(new DOMException(`call exceeded ${ms} ms`, "TimeoutError"));
  }, ms);
  const onParentAbort = () => ctrl.abort(parent.reason);
  parent.addEventListener("abort", onParentAbort, { once: true });
  // The model is kept so llm_calls shows which model (primary or fallback) timed out.
  const timeoutResult = () => llmFailure("timeout", `LLM call exceeded ${ms} ms`, model);
  const abortedResult = () => llmFailure("aborted", "run aborted during the call", model);
  try {
    const attempt = a(ctrl.signal);
    attempt.catch(() => {}); // avoids an unhandled rejection if the abort wins the race; the race still sees the rejection
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

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** Resolves after `ms`, or early when the signal aborts (the next attempt then sees the abort). */
export const abortableSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/** Upper bound of one wait, Retry-After included, so a hostile header cannot park a run. */
const MAX_BACKOFF_MS = 10_000;

export type RetryOptions = { backoffMs?: number; sleep?: Sleep; random?: () => number; signal?: AbortSignal };

/**
 * Up to `attempts` tries; returns the first success or the last failure. Does not repeat "aborted" or a failure with
 * `retryable: false`. Between attempts it waits `backoffMs * 2^i` plus up to 50% jitter, or the Retry-After the
 * provider sent; with no `backoffMs` it does not wait. Each attempt goes to `onAttempt`.
 */
export async function withRetry<O>(
  run: () => Promise<LlmResult<O>>, attempts: number, o: RetryOptions & { onAttempt?: (r: LlmResult<O>) => void } = {},
): Promise<LlmResult<O>> {
  let last: LlmResult<O> = llmFailure("server_error", "no attempt made");
  const total = Math.max(1, attempts);
  for (let i = 0; i < total; i++) {
    last = await run();
    o.onAttempt?.(last);
    if (last.success || last.error.kind === "aborted" || last.error.retryable === false) return last;
    if (i === total - 1) break;
    const base = o.backoffMs ?? 0;
    const retryAfter = last.error.retryAfterMs;
    const wait = retryAfter !== undefined ? retryAfter : base > 0 ? base * 2 ** i * (1 + 0.5 * (o.random ?? Math.random)()) : 0;
    if (wait > 0) await (o.sleep ?? abortableSleep)(Math.min(MAX_BACKOFF_MS, Math.round(wait)), o.signal ?? new AbortController().signal);
  }
  return last;
}

function addUsage(a: LlmUsage | undefined, b: LlmUsage | undefined): LlmUsage | undefined {
  if (!b) return a;
  if (!a) return { ...b };
  const estimated = a.estimated === true || b.estimated === true;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    costUsd: a.costUsd + b.costUsd,
    ...(estimated ? { estimated: true } : {}),
  };
}

const modelOf = (p: LlmProvider): string | undefined => {
  const m = (p as { model?: unknown }).model;
  return typeof m === "string" ? m : undefined;
};

/**
 * 2 attempts on the primary (each with a timeout) and, if configured, 1 on the fallback. The fallback is skipped when the
 * primary's last failure says it would not help (401/402/403). The returned result carries the usage of every
 * attempt (a billed invalid output included), the attempt count and whether the fallback answered.
 */
export function resilient(
  primary: LlmProvider,
  o: { fallback: LlmProvider | null; attempts: 2; timeoutMs: number } & Omit<RetryOptions, "signal">,
): LlmProvider {
  const once = <I, O>(p: LlmProvider, prompt: PromptDef<I, O>, input: I, ctx: RunContext) => () =>
    withTimeout<O>((signal) => p.generate(prompt, input, { ...ctx, signal }), o.timeoutMs, ctx.signal, modelOf(p));
  return {
    name: primary.name,
    async generate<I, O>(prompt: PromptDef<I, O>, input: I, ctx: RunContext): Promise<LlmResult<O>> {
      let attempts = 0;
      let usage: LlmUsage | undefined;
      const count = (r: LlmResult<O>) => {
        attempts += 1;
        usage = addUsage(usage, r.usage);
      };
      const finish = (r: LlmResult<O>, usedFallback: boolean): LlmResult<O> =>
        r.success
          ? { ...r, usage: usage ?? r.usage, attempts, usedFallback }
          : { ...r, ...(usage ? { usage } : {}), attempts, usedFallback };
      const r = await withRetry(once(primary, prompt, input, ctx), o.attempts, { ...o, signal: ctx.signal, onAttempt: count });
      if (r.success || r.error.kind === "aborted" || !o.fallback || r.error.fallbackUseful === false) return finish(r, false);
      const f = await once(o.fallback, prompt, input, ctx)();
      count(f);
      return finish(f, f.success);
    },
  };
}
