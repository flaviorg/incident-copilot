// Cartões de números (spec 5.7 e 10.2, item 5): MTTR e tempo aguardando aprovação em destaque; economia mensal só
// quando houver; minutos economizados e ROI como faixa ilustrativa; cada valor com a origem (medido, premissa,
// derivado). Nada é calculado aqui: os valores vêm da gravação.
import type { IncidentMetrics } from "@contracts";
import { SOURCE_LABELS, formatNumber, formatUsd } from "../labels.ts";

export function MetricsCards({ metrics }: { metrics: IncidentMetrics }) {
  const source = (key: string) => SOURCE_LABELS[metrics.sources[key] ?? "derived"];
  const range = (r: { low: number; high: number } | null, unit: string) => (r === null ? "no resolution" : `${formatNumber(r.low)} to ${formatNumber(r.high)}${unit}`);
  return (
    <section className="panel" aria-labelledby="metrics-title">
      <h2 id="metrics-title">Incident numbers</h2>
      <dl className="metrics-highlight">
        <div className="metric-card">
          <dt>MTTR</dt>
          <dd className="metric-value">{metrics.mttrMin === null ? "not resolved" : `${formatNumber(metrics.mttrMin)} min`}</dd>
          <dd className="metric-source">{source("mttrMin")}</dd>
        </div>
        <div className="metric-card">
          <dt>Time waiting for approval</dt>
          <dd className="metric-value">{`${formatNumber(metrics.timeAwaitingApprovalMin)} min`}</dd>
          <dd className="metric-source">{source("timeAwaitingApprovalMin")}</dd>
        </div>
        {metrics.monthlySavingsUsd > 0 ? (
          <div className="metric-card">
            <dt>Monthly savings</dt>
            <dd className="metric-value">{formatUsd(metrics.monthlySavingsUsd)}</dd>
            <dd className="metric-source">{source("monthlySavingsUsd")}</dd>
          </div>
        ) : null}
      </dl>
      <div className="metrics-ranges" role="group" aria-labelledby="metrics-illustrative">
        <p id="metrics-illustrative" className="illustrative-label">Ranges: illustrative, synthetic baseline (assumptions in data/business-assumptions.json)</p>
        <dl>
          <div className="metric-row">
            <dt>Minutes saved</dt>
            <dd>{range(metrics.minutesSaved, " min")}</dd>
            <dd className="metric-source">{source("minutesSaved")}</dd>
          </div>
          <div className="metric-row">
            <dt>ROI</dt>
            <dd>{range(metrics.roiIllustrative, "x")}</dd>
            <dd className="metric-source">{source("roiIllustrative")}</dd>
          </div>
          <div className="metric-row">
            <dt>Baseline recovery without the copilot</dt>
            <dd>{range(metrics.baselineMttrMin, " min")}</dd>
            <dd className="metric-source">{source("baselineMttrMin")}</dd>
          </div>
        </dl>
      </div>
      <dl className="metrics-small">
        <div className="metric-row">
          <dt>MTTD</dt>
          <dd>{`${formatNumber(metrics.mttdMin)} min`}</dd>
          <dd className="metric-source">{source("mttdMin")}</dd>
        </div>
        <div className="metric-row">
          <dt>LLM cost</dt>
          <dd>{`${formatUsd(metrics.llmCostUsd)} across ${metrics.llmCalls} calls`}</dd>
          <dd className="metric-source">{source("llmCostUsd")}</dd>
        </div>
      </dl>
    </section>
  );
}
