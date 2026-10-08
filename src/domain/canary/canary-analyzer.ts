// Canário (spec 6.7): checagens do cenário sobre a janela pós-ação. Puro. Sem dado, reprova (fail closed).
import type { CanaryCheck, CanaryCheckResult, MetricName } from "../../contracts/index.ts";

export type SignalWindow = { metrics: Partial<Record<MetricName, number[]>> };

export function analyzeCanary(
  checks: CanaryCheck[],
  w: SignalWindow,
  baselines: Partial<Record<MetricName, number>>,
): { healthy: boolean; checks: CanaryCheckResult[] } {
  const results = checks.map((c): CanaryCheckResult => {
    const values = w.metrics[c.metric] ?? [];
    const observed = values.length > 0 ? values.reduce((a, v) => a + v, 0) / values.length : null;
    let limit: number | null = null;
    if (c.threshold !== undefined) limit = c.threshold;
    else if (c.baselineFactor !== undefined && baselines[c.metric] !== undefined) limit = c.baselineFactor * baselines[c.metric]!;
    const passed = observed !== null && limit !== null && observed <= limit;
    return { metric: c.metric, observed, limit: limit ?? 0, passed };
  });
  return { healthy: results.length > 0 && results.every((r) => r.passed), checks: results };
}
