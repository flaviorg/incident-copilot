// Provedor real via OpenRouter (ou qualquer endpoint compatível com a API da OpenAI), com saída estruturada por JSON Schema.
// "Confio, mas confiro" (200960 a 200963): o `parsed` do modelo passa de novo pelo outputSchema antes de ser usado.
import type * as z from "zod";
import { llmFailure } from "./provider.ts";
import type { LlmErrorKind, LlmProvider, LlmResult, PromptDef, RunContext } from "./provider.ts";
import { estimateCostUsd } from "./usage.ts";
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
 * Padrão: ChatOpenAI com baseURL, temperatura baixa, sem retries internos (o retry é nosso) e
 * withStructuredOutput(jsonSchema, includeRaw). O pacote só é carregado na primeira chamada.
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

/** 429 -> rate_limit; 5xx ou rede -> server_error; aborto -> aborted; falha de parse da saída -> invalid_output. */
function classifyProviderError(e: unknown, signal: AbortSignal): { kind: LlmErrorKind; message: string } {
  const name = (e as { name?: unknown })?.name;
  if (signal.aborted || name === "AbortError" || name === "TimeoutError") return { kind: "aborted", message: "call aborted" };
  const status = statusOf(e);
  if (status === 429) return { kind: "rate_limit", message: "the provider answered HTTP 429 (rate limit)" };
  if (status !== null && status >= 500) return { kind: "server_error", message: `the provider answered HTTP ${status}` };
  if (name === "OutputParserException") return { kind: "invalid_output", message: "the model output could not be parsed" };
  if (status !== null) return { kind: "server_error", message: `the provider answered HTTP ${status}` };
  return { kind: "server_error", message: "network or provider failure" };
}

export class OpenRouterProvider implements LlmProvider {
  readonly name = "openrouter" as const;
  private readonly model: string;
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

  async generate<I, O>(prompt: PromptDef<I, O>, input: I, ctx: RunContext): Promise<LlmResult<O>> {
    const started = Date.now();
    try {
      const chat = this.chatFor(prompt as PromptDef<unknown, unknown>);
      const res = await chat.invoke([{ role: "system", content: prompt.system }, { role: "user", content: prompt.buildUser(input) }], { signal: ctx.signal });
      const parsed = prompt.outputSchema.safeParse(res.parsed);
      if (!parsed.success) {
        const where = parsed.error.issues.map((i) => i.path.map(String).join(".") || "(root)").join(", ");
        return llmFailure("invalid_output", `model output does not match the ${prompt.version} schema at ${where}`, this.model);
      }
      const usage = { promptTokens: res.raw.usage_metadata?.input_tokens ?? 0, completionTokens: res.raw.usage_metadata?.output_tokens ?? 0 };
      return {
        success: true,
        data: parsed.data,
        usage: { ...usage, costUsd: estimateCostUsd(this.model, usage, this.prices) },
        model: this.model,
        latencyMs: Date.now() - started,
      };
    } catch (e) {
      const c = classifyProviderError(e, ctx.signal);
      return llmFailure(c.kind, c.message, this.model);
    }
  }
}
