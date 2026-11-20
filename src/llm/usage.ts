// Token usage and estimated cost (spec 5.7 and 7.2, rule 7). The fake costs 0. A real model without a price in
// data/model-prices.json also records 0, so the container warns at startup (missingPrices) instead of staying silent.

/** About 4 characters per token (221522). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export type ModelPrices = {
  version: string;
  note: string;
  models: Record<string, { inputPerMTokUsd: number; outputPerMTokUsd: number }>;
};

/** Configured real models (primary, fallback) that have no entry in the price table: their cost would read as 0. */
export function missingPrices(models: readonly (string | null | undefined)[], prices: ModelPrices): string[] {
  return models.filter((m): m is string => typeof m === "string" && m !== "" && !(m in prices.models));
}

export function estimateCostUsd(model: string, u: { promptTokens: number; completionTokens: number }, prices: ModelPrices): number {
  const p = prices.models[model];
  if (!p) return 0;
  return (u.promptTokens * p.inputPerMTokUsd + u.completionTokens * p.outputPerMTokUsd) / 1_000_000;
}
