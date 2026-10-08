import * as z from "zod";
import { MetricNameSchema, MetricWindowSchema } from "../contracts/index.ts";
import { firstViolation, pointsBetween } from "../domain/telemetry/series.ts";
import { formatMetric, formatTs, hhmm, windowSeconds } from "./format.ts";
import { NO_DATA, scenarioScope } from "./registry.ts";
import type { Tool } from "./registry.ts";

const Params = z.object({
  service: z.string().min(1).describe("Service (or account, in cost scenarios) to query"),
  metric: MetricNameSchema.describe("Metric to query"),
  window: MetricWindowSchema.describe("Window ending now"),
});

export function createQueryMetricsTool(): Tool<z.infer<typeof Params>> {
  return {
    name: "query_metrics",
    description: "Use to measure the size and onset of a signal (5xx, P99 latency, throughput, cost) in a window ending now.",
    paramsSchema: Params,
    run({ service, metric, window }, { scenario, now }) {
      if (service !== scenarioScope(scenario)) return { ok: false, summary: `${NO_DATA}: ${service}`, evidenceRef: null };
      const series = scenario.series[metric];
      if (!series) return { ok: false, summary: `no data for metric ${metric} in this scenario`, evidenceRef: null };
      const toIso = now.toISOString();
      const fromIso = new Date(now.getTime() - windowSeconds(window) * 1000).toISOString();
      const pts = pointsBetween(series, fromIso, toIso);
      if (pts.length === 0) return { ok: false, summary: `no ${metric} samples for ${service} in the ${window} window`, evidenceRef: null };

      const long = windowSeconds(window) > 3600;
      const first = pts[0]!;
      const last = pts.at(-1)!;
      const peak = pts.reduce((a, p) => (p.value > a.value ? p : a), first);
      const mean = pts.reduce((a, p) => a + p.value, 0) / pts.length;
      let text =
        `${metric} of ${service} over ${window} (${formatTs(fromIso, long)}–${formatTs(toIso, long)} UTC, ${pts.length} samples): ` +
        `start ${formatMetric(metric, first.value)}, peak ${formatMetric(metric, peak.value)} at ${formatTs(peak.ts, long)}, ` +
        `last ${formatMetric(metric, last.value)}, mean ${formatMetric(metric, mean)}.`;
      if (scenario.alert.signal === metric && scenario.alert.threshold !== null) {
        const v = firstViolation(pts, scenario.alert.threshold);
        text += v
          ? ` First sample above the alert threshold (${formatMetric(metric, scenario.alert.threshold)}) at ${formatTs(v, long)}.`
          : ` No sample above the alert threshold (${formatMetric(metric, scenario.alert.threshold)}).`;
      }
      return {
        ok: true,
        summary: text,
        evidenceRef: `metrics:${service}:${metric}@${hhmm(fromIso, long)}-${hhmm(toIso, long)}`,
        data: { fromIso, toIso, first, peak, last, mean, points: pts.length },
      };
    },
  };
}
