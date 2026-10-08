import { test } from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import { resilient, withRetry, withTimeout } from "../../src/llm/resilience.ts";
import { OpenRouterProvider } from "../../src/llm/openrouter-provider.ts";
import type { StructuredChat } from "../../src/llm/openrouter-provider.ts";
import { withCallRecording } from "../../src/llm/recording-provider.ts";
import { createLlmProvider } from "../../src/llm/create-provider.ts";
import { llmFailure } from "../../src/llm/provider.ts";
import type { LlmErrorKind, LlmProvider, LlmResult, PromptDef, RunContext } from "../../src/llm/provider.ts";
import type { ModelPrices } from "../../src/llm/usage.ts";
import { loadConfig } from "../../src/config.ts";
import { SimulatedClock } from "../../src/infra/clock.ts";
import type { LlmCallRecord } from "../../src/contracts/index.ts";

const prompt: PromptDef<Record<string, never>, { ok: boolean }> = {
  id: "probe",
  version: "probe.v1",
  system: "Responda ok.",
  buildUser: () => "{}",
  matchKeys: () => ({}),
  inputSchema: z.object({}) as unknown as z.ZodType<Record<string, never>>,
  outputSchema: z.object({ ok: z.boolean() }),
};
const ctx: RunContext = { incidentId: "INC-0001", runId: "RUN-0001", scenarioId: "s1", requestId: null, signal: new AbortController().signal };
const prices: ModelPrices = { version: "t", note: "teste", models: { m: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 } } };
const opts = { fallback: null, attempts: 2 as const, timeoutMs: 1000 };
const kindOf = (r: LlmResult<unknown>) => (r.success ? "ok" : r.error.kind);

type Stub = LlmProvider & { calls: number };
function stub(seq: (LlmErrorKind | "ok")[], model = "primary-model"): Stub {
  const s = {
    name: "fake" as const,
    calls: 0,
    async generate<I, O>(_p: PromptDef<I, O>, _i: I, _c: RunContext): Promise<LlmResult<O>> {
      const k = seq[Math.min(s.calls, seq.length - 1)]!;
      s.calls += 1;
      if (k === "ok") return { success: true, data: { ok: true } as O, usage: { promptTokens: 3, completionTokens: 2, costUsd: 0 }, model, latencyMs: 0 };
      return llmFailure(k, `falha ${k}`, model);
    },
  };
  return s;
}

test("retries once after a failure and succeeds", async () => {
  const p = stub(["server_error", "ok"]);
  const r = await resilient(p, opts).generate(prompt, {}, ctx);
  assert.ok(r.success);
  assert.equal(p.calls, 2);
});

test("aborted is not retried", async () => {
  const p = stub(["aborted", "ok"]);
  assert.equal(kindOf(await resilient(p, opts).generate(prompt, {}, ctx)), "aborted");
  assert.equal(p.calls, 1);
  const q = stub(["aborted", "ok"]);
  assert.equal(kindOf(await withRetry(() => q.generate(prompt, {}, ctx), 2)), "aborted");
  assert.equal(q.calls, 1);
});

test("falls back after two primary failures", async () => {
  const primary = stub(["server_error", "server_error"]);
  const r = await resilient(primary, { fallback: stub(["ok"], "fallback-model"), attempts: 2, timeoutMs: 1000 }).generate(prompt, {}, ctx);
  assert.ok(r.success && r.model === "fallback-model");
  assert.equal(primary.calls, 2);
});

test("fails when primary and fallback fail", async () => {
  const r = await resilient(stub(["server_error"]), { fallback: stub(["rate_limit"], "fallback-model"), attempts: 2, timeoutMs: 1000 }).generate(prompt, {}, ctx);
  assert.equal(kindOf(r), "rate_limit");
});

test("withTimeout turns a hanging attempt into timeout and a parent abort into aborted", async () => {
  const hanging = () => new Promise<LlmResult<{ ok: boolean }>>(() => {});
  const t0 = Date.now();
  assert.equal(kindOf(await withTimeout(hanging, 20, new AbortController().signal)), "timeout");
  assert.ok(Date.now() - t0 < 500);
  const parent = new AbortController();
  setTimeout(() => parent.abort(), 10);
  assert.equal(kindOf(await withTimeout(hanging, 1000, parent.signal)), "aborted");
  // Um attempt que respeita o sinal e devolve "aborted" vira "timeout" quando quem abortou foi o próprio timer.
  const polite = (signal: AbortSignal) =>
    new Promise<LlmResult<{ ok: boolean }>>((resolve) => signal.addEventListener("abort", () => resolve(llmFailure("aborted", "x"))));
  assert.equal(kindOf(await withTimeout(polite, 20, new AbortController().signal)), "timeout");
});

function chat(o: { parsed?: unknown; usage?: { input_tokens?: number; output_tokens?: number }; throws?: unknown }): StructuredChat {
  return {
    async invoke() {
      if (o.throws) throw o.throws;
      return { raw: o.usage ? { usage_metadata: o.usage } : {}, parsed: o.parsed };
    },
  };
}
const withChat = (o: Parameters<typeof chat>[0]) => new OpenRouterProvider({ apiKey: "k", model: "m", baseUrl: "u", prices, chatFactory: () => chat(o) });

test("OpenRouterProvider maps usage, invalid output and HTTP errors", async () => {
  const seen: { role: string; content: string }[][] = [];
  const ok = new OpenRouterProvider({
    apiKey: "k", model: "m", baseUrl: "u", prices,
    chatFactory: () => ({ async invoke(messages) { seen.push(messages); return { raw: { usage_metadata: { input_tokens: 10, output_tokens: 5 } }, parsed: { ok: true } }; } }),
  });
  const r = await ok.generate(prompt, {}, ctx);
  assert.ok(r.success);
  assert.deepEqual([r.usage.promptTokens, r.usage.completionTokens], [10, 5]);
  assert.equal(r.usage.costUsd, (10 * 1 + 5 * 2) / 1_000_000);
  assert.equal(r.model, "m");
  assert.deepEqual(seen[0], [{ role: "system", content: "Responda ok." }, { role: "user", content: "{}" }]);
  assert.equal(kindOf(await withChat({ parsed: { ok: "x" } }).generate(prompt, {}, ctx)), "invalid_output");
  assert.equal(kindOf(await withChat({ throws: { status: 429 } }).generate(prompt, {}, ctx)), "rate_limit");
  assert.equal(kindOf(await withChat({ throws: { status: 502 } }).generate(prompt, {}, ctx)), "server_error");
  assert.equal(kindOf(await withChat({ throws: new TypeError("fetch failed") }).generate(prompt, {}, ctx)), "server_error");
});

test("createLlmProvider builds without network", () => {
  const store = { recordLlmCall: () => {} };
  const clock = new SimulatedClock(new Date("2026-10-04T09:00:00Z"));
  const c = loadConfig({ LLM_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-v1-" + "z".repeat(40), OPENROUTER_MODEL: "m", OPENROUTER_MODEL_FALLBACK: "m2" });
  const built = createLlmProvider(c, { fixtures: [], prices, store, clock });
  assert.equal(built.provider.name, "openrouter");
  assert.equal(built.fake, null);
  const fake = createLlmProvider(loadConfig({}), { fixtures: [], prices, store, clock });
  assert.equal(fake.provider.name, "fake");
  assert.ok(fake.fake);
});

test("withCallRecording stores successes and failures and ticks 20 s", async () => {
  const rows: LlmCallRecord[] = [];
  const clock = new SimulatedClock(new Date("2026-10-04T09:42:30.000Z"));
  const p = withCallRecording(stub(["ok", "server_error"]), { store: { recordLlmCall: (c) => void rows.push(c) }, clock, tickSec: 20 });
  assert.ok((await p.generate(prompt, {}, ctx)).success);
  assert.equal(kindOf(await p.generate(prompt, {}, ctx)), "server_error");
  assert.equal(clock.now().toISOString(), "2026-10-04T09:43:10.000Z");
  assert.deepEqual(rows.map((r) => [r.promptVersion, r.model, r.success, r.errorKind, r.ts]), [
    ["probe.v1", "primary-model", true, null, "2026-10-04T09:42:50.000Z"],
    ["probe.v1", "primary-model", false, "server_error", "2026-10-04T09:43:10.000Z"],
  ]);
  assert.deepEqual([rows[0]!.promptTokens, rows[0]!.completionTokens, rows[0]!.incidentId, rows[0]!.runId], [3, 2, "INC-0001", "RUN-0001"]);
});
