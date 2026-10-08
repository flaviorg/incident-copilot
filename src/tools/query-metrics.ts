import * as z from "zod";
import { MetricNameSchema, MetricWindowSchema } from "../contracts/index.ts";
import { firstViolation, pointsBetween } from "../domain/telemetry/series.ts";
import { formatMetric, formatTs, hhmm, windowSeconds } from "./format.ts";
import { NO_DATA, scenarioScope } from "./registry.ts";
import type { Tool } from "./registry.ts";

const Params = z.object({
  service: z.string().min(1).describe("Serviço (ou conta, em cenários de custo) a consultar"),
  metric: MetricNameSchema.describe("Métrica a consultar"),
  window: MetricWindowSchema.describe("Janela que termina agora"),
});

export function createQueryMetricsTool(): Tool<z.infer<typeof Params>> {
  return {
    name: "query_metrics",
    description: "Use para medir o tamanho e o início de um sinal (5xx, latência P99, vazão, custo) numa janela que termina agora.",
    paramsSchema: Params,
    run({ service, metric, window }, { scenario, now }) {
      if (service !== scenarioScope(scenario)) return { ok: false, summary: `${NO_DATA}: ${service}`, evidenceRef: null };
      const series = scenario.series[metric];
      if (!series) return { ok: false, summary: `métrica ${metric} sem dados neste cenário`, evidenceRef: null };
      const toIso = now.toISOString();
      const fromIso = new Date(now.getTime() - windowSeconds(window) * 1000).toISOString();
      const pts = pointsBetween(series, fromIso, toIso);
      if (pts.length === 0) return { ok: false, summary: `${metric} de ${service} sem amostras na janela de ${window}`, evidenceRef: null };

      const long = windowSeconds(window) > 3600;
      const first = pts[0]!;
      const last = pts.at(-1)!;
      const peak = pts.reduce((a, p) => (p.value > a.value ? p : a), first);
      const mean = pts.reduce((a, p) => a + p.value, 0) / pts.length;
      let text =
        `${metric} de ${service} em ${window} (${formatTs(fromIso, long)}–${formatTs(toIso, long)} UTC, ${pts.length} amostras): ` +
        `início ${formatMetric(metric, first.value)}, pico ${formatMetric(metric, peak.value)} às ${formatTs(peak.ts, long)}, ` +
        `último ${formatMetric(metric, last.value)}, média ${formatMetric(metric, mean)}.`;
      if (scenario.alert.signal === metric && scenario.alert.threshold !== null) {
        const v = firstViolation(pts, scenario.alert.threshold);
        text += v
          ? ` Primeira amostra acima do limiar do alerta (${formatMetric(metric, scenario.alert.threshold)}) às ${formatTs(v, long)}.`
          : ` Nenhuma amostra acima do limiar do alerta (${formatMetric(metric, scenario.alert.threshold)}).`;
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
