// Real provider via OpenRouter (or any OpenAI-API-compatible endpoint), with structured output by JSON Schema.
// "Trust, but verify" (200960 to 200963): the model's `parsed` goes through the outputSchema again before it is used.
import type * as z from "zod";
import { llmFailure } from "./provider.ts";
import type { FailureExtra, LlmErrorKind, LlmProvider, LlmResult, PromptDef, RunContext } from "./provider.ts";
import { estimateCostUsd, estimateTokens } from "./usage.ts";
import type { ModelPrices } from "./usage.ts";

export type ChatMessage = { role: "system" | "user"; content: string };
export type StructuredChat = {
  invoke(messages: ChatMessage[], o: { signal: AbortSignal }): Promise<{
    raw: { usage_metadata?: { input_tokens?: number; output_tokens?: number } };
    parsed: unknown;
  }>;
};
export type ChatFactory = (model: string, schema: z.ZodType) => StructuredChat;

/**
 * Default: ChatOpenAI with baseURL, low temperature, no internal retries (the retry is ours) and
 * withStructuredOutput(jsonSchema, includeRaw). The package is only loaded on the first call.
 */
function defaultChatFactory(o: { apiKey: string; baseUrl: string }): ChatFactory {
  return (model, schema) => ({
    async invoke(messages, opts) {
      const { ChatOpenAI } = await import("@langchain/openai");
      const llm = new ChatOpenAI({ model, apiKey: o.apiKey, configuration: { baseURL: o.baseUrl }, temperature: 0.2, maxRetries: 0 });
      const runnable = llm.withStructuredOutput(schema as z.ZodType<Record<string, unknown>>, { method: "jsonSchema", includeRaw: true });
      const out = await runnable.invoke(messages, { signal: opts.signal });
      return { raw: out.raw as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }, parsed: out.parsed };
    },
  });
}

function statusOf(e: unknown): number | null {
  if (e === null || typeof e !== "object") return null;
  const o = e as { status?: unknown; response?: { status?: unknown } };
  const s = typeof o.status === "number" ? o.status : typeof o.response?.status === "number" ? o.response.status : null;
  return s;
}

/** Retry-After in seconds (or an HTTP date), from `headers` as a plain object or a Headers instance. */
function retryAfterMsOf(e: unknown): number | undefined {
  const o = e as { headers?: unknown; response?: { headers?: unknown } } | null;
  const h = o?.headers ?? o?.response?.headers;
  let raw: unknown;
  if (h && typeof (h as { get?: unknown }).get === "function") raw = (h as { get(n: string): unknown }).get("retry-after");
  else if (h && typeof h === "object") raw = (h as Record<string, unknown>)["retry-after"];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/**
 * 429 -> rate_limit; 5xx or network -> server_error; abort -> aborted; output parse failure -> invalid_output.
 * Any other 4xx except 408 is a request or account problem: server_error with `retryable: false`; 401, 402 and 403 also
 * get `fallbackUseful: false`, because the fallback model uses the same key.
 */
function classifyProviderError(e: unknown, signal: AbortSignal): { kind: LlmErrorKind; message: string } & FailureExtra {
  const name = (e as { name?: unknown })?.name;
  if (signal.aborted || name === "AbortError" || name === "TimeoutError") return { kind: "aborted", message: "call aborted" };
  const status = statusOf(e);
  if (status === 429) {
    const retryAfterMs = retryAfterMsOf(e);
    return { kind: "rate_limit", message: "the provider answered HTTP 429 (rate limit)", ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }
  if (status !== null && status >= 500) return { kind: "server_error", message: `the provider answered HTTP ${status}` };
  if (name === "OutputParserException") return { kind: "invalid_output", message: "the model output could not be parsed" };
  if (status === 408) return { kind: "server_error", message: "the provider answered HTTP 408" };
  if (status !== null && status >= 400) {
    const sameKeyFails = status === 401 || status === 402 || status === 403;
    return {
      kind: "server_error", message: `the provider answered HTTP ${status} (not retried)`, retryable: false,
      ...(sameKeyFails ? { fallbackUseful: false } : {}),
    };
  }
  if (status !== null) return { kind: "server_error", message: `the provider answered HTTP ${status}` };
  return { kind: "server_error", message: "network or provider failure" };
}

type RawUsage = { usage_metadata?: { input_tokens?: number; output_tokens?: number } };

export class OpenRouterProvider implements LlmProvider {
  readonly name = "openrouter" as const;
  readonly model: string;
  private readonly prices: ModelPrices;
  private readonly chatFactory: ChatFactory;
  private readonly chats = new Map<string, StructuredChat>();

  constructor(o: { apiKey: string; model: string; baseUrl: string; prices: ModelPrices; chatFactory?: ChatFactory }) {
    this.model = o.model;
    this.prices = o.prices;
    this.chatFactory = o.chatFactory ?? defaultChatFactory({ apiKey: o.apiKey, baseUrl: o.baseUrl });
  }

  private chatFor(p: PromptDef<unknown, unknown>): StructuredChat {
    let chat = this.chats.get(p.version);
    if (!chat) {
      chat = this.chatFactory(this.model, p.outputSchema as z.ZodType);
      this.chats.set(p.version, chat);
    }
    return chat;
  }

  private usageOf(raw: RawUsage, sent: string, received: unknown) {
    const m = raw.usage_metadata;
    const reported = m !== undefined && (typeof m.input_tokens === "number" || typeof m.output_tokens === "number");
    const tokens = reported
      ? { promptTokens: m!.input_tokens ?? 0, completionTokens: m!.output_tokens ?? 0 }
      : { promptTokens: estimateTokens(sent), completionTokens: estimateTokens(JSON.stringify(received ?? null)) };
    return { ...tokens, costUsd: estimateCostUsd(this.model, tokens, this.prices), ...(reported ? {} : { estimated: true }) };
  }

  async generate<I, O>(prompt: PromptDef<I, O>, input: I, ctx: RunContext): Promise<LlmResult<O>> {
    const started = Date.now();
    // Built outside the try: a buildUser defect (a ZodError on the node's input) is a repository bug and must throw,
    // not pose as a provider outage that is retried and sent to the fallback.
    const messages = [{ role: "system" as const, content: prompt.system }, { role: "user" as const, content: prompt.buildUser(input) }];
    const sent = prompt.system + messages[1]!.content;
    try {
      const chat = this.chatFor(prompt as PromptDef<unknown, unknown>);
      const res = await chat.invoke(messages, { signal: ctx.signal });
      const usage = this.usageOf(res.raw, sent, res.parsed);
      const parsed = prompt.outputSchema.safeParse(res.parsed);
      if (!parsed.success) {
        const where = parsed.error.issues.map((i) => i.path.map(String).join(".") || "(root)").join(", ");
        return llmFailure("invalid_output", `model output does not match the ${prompt.version} schema at ${where}`, this.model, { usage });
      }
      return { success: true, data: parsed.data, usage, model: this.model, latencyMs: Date.now() - started };
    } catch (e) {
      const { kind, message, ...extra } = classifyProviderError(e, ctx.signal);
      return llmFailure(kind, message, this.model, extra);
    }
  }
}
