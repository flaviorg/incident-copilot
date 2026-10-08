// Uso de tokens e custo estimado (spec 5.7 e 7.2, regra 7). O fake custa 0; modelo sem preço também custa 0.

/** Cerca de 4 caracteres por token (221522). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export type ModelPrices = {
  version: string;
  note: string;
  models: Record<string, { inputPerMTokUsd: number; outputPerMTokUsd: number }>;
};

export function estimateCostUsd(model: string, u: { promptTokens: number; completionTokens: number }, prices: ModelPrices): number {
  const p = prices.models[model];
  if (!p) return 0;
  return (u.promptTokens * p.inputPerMTokUsd + u.completionTokens * p.outputPerMTokUsd) / 1_000_000;
}
