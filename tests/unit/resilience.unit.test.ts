import { test } from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import { resilient, withRetry, withTimeout } from "../../src/llm/resilience.ts";
import { OpenRouterProvider } from "../../src/llm/openrouter-provider.ts";
import type { StructuredChat } from "../../src/llm/openrouter-provider.ts";
import { withCallRecording } from "../../src/llm/recording-provider.ts";
import { createLlmProvider } from "../../src/llm/create-provider.ts";
import { missingPrices } from "../../src/llm/usage.ts";
import { createContainer } from "../../src/app/container.ts";
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
  // An attempt that honors the signal and returns "aborted" becomes "timeout" when the timer itself aborted.
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
  const p = withCallRecording(stub(["ok", "server_error"]), { store: { recordLlmCall: (c) => void rows.push(c as LlmCallRecord) }, clock, tickSec: 20 });
  assert.ok((await p.generate(prompt, {}, ctx)).success);
  assert.equal(kindOf(await p.generate(prompt, {}, ctx)), "server_error");
  assert.equal(clock.now().toISOString(), "2026-10-04T09:43:10.000Z");
  assert.deepEqual(rows.map((r) => [r.promptVersion, r.model, r.success, r.errorKind, r.ts]), [
    ["probe.v1", "primary-model", true, null, "2026-10-04T09:42:50.000Z"],
    ["probe.v1", "primary-model", false, "server_error", "2026-10-04T09:43:10.000Z"],
  ]);
  assert.deepEqual([rows[0]!.promptTokens, rows[0]!.completionTokens, rows[0]!.incidentId, rows[0]!.runId], [3, 2, "INC-0001", "RUN-0001"]);
});

test("missingPrices lists the configured real models without a price, so cost is never a silent 0", () => {
  // Review 2026-11: data/model-prices.json ships empty, so every OpenRouter call was recorded as $0.00 with no signal.
  const table = { version: "x", note: "x", models: { "known/model": { inputPerMTokUsd: 1, outputPerMTokUsd: 2 } } };
  assert.deepEqual(missingPrices(["known/model", "typo/model", null], table), ["typo/model"]);
  assert.deepEqual(missingPrices(["known/model"], table), []);
});

test("an OpenRouter container with an unpriced model logs a loud llm_price_missing warning at startup", () => {
  const lines: string[] = [];
  const c = createContainer(
    loadConfig({ LLM_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-v1-" + "z".repeat(40), OPENROUTER_MODEL: "vendor/unpriced-model", DB_PATH: ":memory:", CLOCK: "simulated" }),
    { fixtures: [], logWrite: (l) => void lines.push(l) },
  );
  try {
    const warn = lines.map((l) => JSON.parse(l)).find((l) => l.event === "llm_price_missing");
    assert.ok(warn, "warning logged");
    assert.equal(warn.level, "warn");
    assert.deepEqual(warn.models, ["vendor/unpriced-model"]);
    assert.ok(!lines.join("\n").includes("z".repeat(40)), "the key is never logged");
  } finally {
    c.close();
  }
});

// ---------- Review 2026-11: LLM and resilience findings ----------

test("a buildUser defect in OpenRouterProvider throws instead of posing as a provider outage", async () => {
  const broken = { ...prompt, buildUser: () => { throw new z.ZodError([]); } };
  let invoked = 0;
  const p = new OpenRouterProvider({ apiKey: "k", model: "m", baseUrl: "u", prices, chatFactory: () => ({ async invoke() { invoked++; return { raw: {}, parsed: { ok: true } }; } }) });
  await assert.rejects(() => p.generate(broken, {}, ctx), z.ZodError);
  assert.equal(invoked, 0);
});

test("4xx other than 408/429 is not retried; 401/402/403 also skip the fallback", async () => {
  for (const status of [400, 404]) {
    const p = withChat({ throws: { status } });
    const r = await p.generate(prompt, {}, ctx);
    assert.ok(!r.success && r.error.retryable === false, `HTTP ${status}`);
    assert.notEqual(r.success ? null : r.error.fallbackUseful, false, `HTTP ${status} may still try the fallback`);
  }
  for (const status of [401, 402, 403]) {
    const r = await withChat({ throws: { status } }).generate(prompt, {}, ctx);
    assert.ok(!r.success && r.error.retryable === false && r.error.fallbackUseful === false, `HTTP ${status}`);
  }
  for (const status of [408, 429, 503]) {
    const r = await withChat({ throws: { status } }).generate(prompt, {}, ctx);
    assert.ok(!r.success && r.error.retryable !== false, `HTTP ${status} is retryable`);
  }
  // resilient honours the flags
  let primaryCalls = 0; let fallbackCalls = 0;
  const failing = (status: number, onCall: () => void) => new OpenRouterProvider({
    apiKey: "k", model: "m", baseUrl: "u", prices, chatFactory: () => ({ async invoke() { onCall(); throw { status }; } }),
  });
  await resilient(failing(401, () => primaryCalls++), { ...opts, fallback: failing(401, () => fallbackCalls++) }).generate(prompt, {}, ctx);
  assert.deepEqual([primaryCalls, fallbackCalls], [1, 0]);
  primaryCalls = 0; fallbackCalls = 0;
  await resilient(failing(404, () => primaryCalls++), { ...opts, fallback: failing(404, () => fallbackCalls++) }).generate(prompt, {}, ctx);
  assert.deepEqual([primaryCalls, fallbackCalls], [1, 1]);
});

test("retry waits with exponential backoff and honours Retry-After", async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  await resilient(stub(["server_error", "server_error"]), { ...opts, backoffMs: 100, sleep, random: () => 0 }).generate(prompt, {}, ctx);
  assert.deepEqual(waits, [100]);
  waits.length = 0;
  const limited = {
    name: "openrouter" as const,
    async generate<I, O>(): Promise<LlmResult<O>> { return llmFailure("rate_limit", "429", "m", { retryAfterMs: 2500 }); },
  };
  await resilient(limited, { ...opts, backoffMs: 100, sleep, random: () => 0 }).generate(prompt, {}, ctx);
  assert.deepEqual(waits, [2500]);
  waits.length = 0;
  await resilient(stub(["server_error", "ok"]), { ...opts, sleep }).generate(prompt, {}, ctx);
  assert.deepEqual(waits, [], "no backoff configured means no wait");
});

test("usage of failed attempts is summed into the logical call and recorded with attempts and fallback", async () => {
  const usage = { promptTokens: 10, completionTokens: 4, costUsd: 0.5 };
  const invalidTwice = {
    name: "openrouter" as const,
    async generate<I, O>(): Promise<LlmResult<O>> { return llmFailure("invalid_output", "bad", "primary", { usage }); },
  };
  const rows: LlmCallRecord[] = [];
  const clock = new SimulatedClock(new Date("2026-10-04T09:00:00Z"));
  const p = withCallRecording(resilient(invalidTwice, { ...opts, fallback: stub(["ok"], "fallback-model") }), { store: { recordLlmCall: (c) => void rows.push(c as LlmCallRecord) }, clock, tickSec: 20 });
  const r = await p.generate(prompt, {}, ctx);
  assert.ok(r.success && r.model === "fallback-model");
  assert.deepEqual([rows[0]!.promptTokens, rows[0]!.completionTokens, rows[0]!.costUsd], [23, 10, 1]);
  assert.equal(rows[0]!.attempts, 3);
  assert.equal(rows[0]!.usedFallback, true);
  assert.equal(rows[0]!.model, "fallback-model");
});

test("OpenRouterProvider keeps the usage of an invalid output and estimates a missing usage", async () => {
  const bad = await withChat({ parsed: { ok: "x" }, usage: { input_tokens: 7, output_tokens: 3 } }).generate(prompt, {}, ctx);
  assert.ok(!bad.success);
  assert.deepEqual([bad.usage?.promptTokens, bad.usage?.completionTokens], [7, 3]);
  const noUsage = await withChat({ parsed: { ok: true } }).generate(prompt, {}, ctx);
  assert.ok(noUsage.success);
  assert.ok(noUsage.usage.promptTokens > 0 && noUsage.usage.completionTokens > 0);
  assert.equal(noUsage.usage.estimated, true);
});

test("a timeout records which model timed out", async () => {
  const hanging = new OpenRouterProvider({ apiKey: "k", model: "vendor/slow", baseUrl: "u", prices, chatFactory: () => ({ invoke: () => new Promise(() => {}) }) });
  const r = await resilient(hanging, { ...opts, attempts: 2, timeoutMs: 10 }).generate(prompt, {}, ctx);
  assert.ok(!r.success && r.error.kind === "timeout");
  assert.equal(r.model, "vendor/slow");
});
