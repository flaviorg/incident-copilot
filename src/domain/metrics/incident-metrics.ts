// Métricas do incidente por funções puras (spec 5.7). Nenhuma chama o LLM.
// Minutos economizados e ROI são faixas sobre linha de base sintética, rotulados como ilustrativos.
import type { Alert, Approval, GatedAction, IncidentMetrics, MetricName, MetricSource, Range, RootCauseCategory, SeriesPoint } from "../../contracts/index.ts";
import { firstViolation, meanBetween } from "../telemetry/series.ts";

export type BusinessAssumptions = {
  version: string;
  note: string;
  engineersEngaged: number;
  engineerHourlyCostUsd: number;
  copilotMonthlyCostUsd: number;
  incidentsPerMonth: number;
  revenuePerMinuteUsd: Record<string, number>;
  baselineMttrMin: Record<string, { low: number; high: number }>;
};

export type MetricsInput = {
  alert: Alert;
  series: Partial<Record<MetricName, SeriesPoint[]>>;
  resolvedAt: string | null;
  approvals: Approval[];
  actions: GatedAction[];
  category: RootCauseCategory;
  firstMitigationAt: string | null; // resolvido pelo chamador (o catálogo, que sabe o que mitiga, chega na Tarefa 23)
  executedSavingsUsd: number[];
  llmCalls: { costUsd: number; promptTokens: number; completionTokens: number }[];
  assumptions: BusinessAssumptions;
};

const DEFAULT_BASELINE_MTTR_MIN: Range = { low: 45, high: 95 };
/** Sinal de erro usado em impactFraction. */
export const ERROR_RATE_METRIC: MetricName = "http_5xx_rate";

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
const minutesBetween = (fromIso: string, toIso: string) => (Date.parse(toIso) - Date.parse(fromIso)) / 60000;
const range = (low: number, high: number): Range => ({ low: round4(low), high: round4(high) });

const METRIC_SOURCES: Record<string, MetricSource> = {
  impactStartedAt: "measured",
  detectedAt: "measured",
  resolvedAt: "measured",
  mttdMin: "measured",
  mttrMin: "measured",
  timeAwaitingApprovalMin: "measured",
  baselineMttrMin: "assumption",
  minutesSaved: "derived",
  impactFraction: "measured",
  revenuePerMinuteUsd: "assumption",
  downtimeCostAvoidedUsd: "derived",
  engineeringCostSavedUsd: "derived",
  monthlySavingsUsd: "derived",
  llmCostUsd: "measured",
  copilotCostUsd: "derived",
  roiIllustrative: "derived",
  llmCalls: "measured",
  promptTokens: "measured",
  completionTokens: "measured",
};

/** Primeira amostra do sinal principal que viola o limiar até a detecção; sem sinal com limiar (custo), a própria detecção. */
export function impactStartOf(alert: Alert, series: Partial<Record<MetricName, SeriesPoint[]>>): string {
  const points = series[alert.signal];
  if (alert.threshold === null || !points) return alert.detectedAt;
  const upToDetection = points.filter((p) => Date.parse(p.ts) <= Date.parse(alert.detectedAt));
  return firstViolation(upToDetection, alert.threshold) ?? alert.detectedAt;
}

export function computeIncidentMetrics(i: MetricsInput): IncidentMetrics {
  const a = i.assumptions;
  const impactStartedAt = impactStartOf(i.alert, i.series);
  const detectedAt = i.alert.detectedAt;
  const mttdMin = round4(minutesBetween(impactStartedAt, detectedAt));
  const mttrMin = i.resolvedAt === null ? null : round4(minutesBetween(impactStartedAt, i.resolvedAt));
  const timeAwaitingApprovalMin = round4(
    i.approvals.filter((ap) => ap.decidedAt !== null).reduce((acc, ap) => acc + minutesBetween(ap.requestedAt, ap.decidedAt!), 0),
  );

  const baseline = a.baselineMttrMin[i.category] ?? DEFAULT_BASELINE_MTTR_MIN;
  const minutesSaved = mttrMin === null ? null : range(Math.max(0, baseline.low - mttrMin), Math.max(0, baseline.high - mttrMin));

  const errorSeries = i.series[ERROR_RATE_METRIC];
  const impactFraction =
    errorSeries && i.firstMitigationAt !== null ? round4(Math.min(1, Math.max(0, meanBetween(errorSeries, impactStartedAt, i.firstMitigationAt) ?? 0))) : 0;
  const revenuePerMinuteUsd = i.alert.service === null ? 0 : (a.revenuePerMinuteUsd[i.alert.service] ?? 0);

  const saved = minutesSaved ?? { low: 0, high: 0 };
  const downtimeCostAvoidedUsd = range(saved.low * revenuePerMinuteUsd * impactFraction, saved.high * revenuePerMinuteUsd * impactFraction);
  const engineeringCostSavedUsd = range(
    (saved.low / 60) * a.engineersEngaged * a.engineerHourlyCostUsd,
    (saved.high / 60) * a.engineersEngaged * a.engineerHourlyCostUsd,
  );
  const monthlySavingsUsd = round4(i.executedSavingsUsd.reduce((acc, x) => acc + x, 0));

  const llmCostUsd = round4(i.llmCalls.reduce((acc, c) => acc + c.costUsd, 0));
  const copilotCostUsd = round4(a.copilotMonthlyCostUsd / a.incidentsPerMonth + llmCostUsd);
  const roi = (benefit: number) => (benefit - copilotCostUsd) / copilotCostUsd;
  const roiIllustrative =
    (mttrMin === null && monthlySavingsUsd === 0) || copilotCostUsd <= 0
      ? null
      : range(
          roi(downtimeCostAvoidedUsd.low + engineeringCostSavedUsd.low + monthlySavingsUsd),
          roi(downtimeCostAvoidedUsd.high + engineeringCostSavedUsd.high + monthlySavingsUsd),
        );

  return {
    impactStartedAt,
    detectedAt,
    resolvedAt: i.resolvedAt,
    mttdMin,
    mttrMin,
    timeAwaitingApprovalMin,
    baselineMttrMin: { low: baseline.low, high: baseline.high },
    minutesSaved,
    impactFraction,
    revenuePerMinuteUsd,
    downtimeCostAvoidedUsd,
    engineeringCostSavedUsd,
    monthlySavingsUsd,
    llmCostUsd,
    copilotCostUsd,
    roiIllustrative,
    llmCalls: i.llmCalls.length,
    promptTokens: i.llmCalls.reduce((acc, c) => acc + c.promptTokens, 0),
    completionTokens: i.llmCalls.reduce((acc, c) => acc + c.completionTokens, 0),
    assumptionsVersion: a.version,
    sources: { ...METRIC_SOURCES },
  };
}
