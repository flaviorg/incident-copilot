// Monta o provedor a partir da config: fake roteirizado por padrão; openrouter com timeout, retry, fallback e registro.
import type { Config } from "../config.ts";
import type { SqliteIncidentStore } from "../infra/db/incident-store.ts";
import type { Clock } from "../infra/clock.ts";
import { FakeLlmProvider } from "./fake-provider.ts";
import type { FixtureFile } from "./fixture-format.ts";
import { OpenRouterProvider } from "./openrouter-provider.ts";
import type { LlmProvider } from "./provider.ts";
import { LLM_CALL_TICK_SEC, withCallRecording } from "./recording-provider.ts";
import { resilient } from "./resilience.ts";
import type { ModelPrices } from "./usage.ts";

export function createLlmProvider(
  c: Config,
  d: { fixtures: FixtureFile[]; prices: ModelPrices; store: Pick<SqliteIncidentStore, "recordLlmCall">; clock: Clock },
): { provider: LlmProvider; fake: FakeLlmProvider | null } {
  const record = (p: LlmProvider) => withCallRecording(p, { store: d.store, clock: d.clock, tickSec: LLM_CALL_TICK_SEC });
  if (c.llmProvider === "fake") {
    const fake = new FakeLlmProvider({ fixtures: d.fixtures });
    return { provider: record(resilient(fake, { fallback: null, attempts: 2, timeoutMs: c.llmTimeoutMs })), fake };
  }
  if (!c.openrouterApiKey || !c.openrouterModel) throw new Error("provedor openrouter sem chave ou modelo (a config deveria ter falhado antes)");
  const make = (model: string) => new OpenRouterProvider({ apiKey: c.openrouterApiKey!, model, baseUrl: c.llmBaseUrl, prices: d.prices });
  const fallback = c.openrouterModelFallback ? make(c.openrouterModelFallback) : null;
  return { provider: record(resilient(make(c.openrouterModel), { fallback, attempts: 2, timeoutMs: c.llmTimeoutMs })), fake: null };
}
