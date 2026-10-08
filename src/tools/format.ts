// Formatação en-US (sem separador de milhar) para os resumos das ferramentas e para a CLI.
import type { MetricName, MetricWindow } from "../contracts/index.ts";

export function formatNumber(n: number, digits = 2): string {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(n);
}

export function formatUsd(n: number): string {
  return `US$ ${formatNumber(n, 2)}`;
}

/** Taxa em %, latência em ms, vazão em req/s, custo em US$. */
export function formatMetric(metric: MetricName, v: number): string {
  switch (metric) {
    case "http_5xx_rate":
      return `${formatNumber(v * 100, 1)}%`;
    case "p99_latency_ms":
      return `${formatNumber(v, 0)} ms`;
    case "request_rate":
      return `${formatNumber(v, 0)} req/s`;
    case "daily_cost_usd":
    case "projected_monthly_cost_usd":
      return formatUsd(v);
  }
}

const WINDOW_SEC: Record<MetricWindow, number> = { "15m": 900, "30m": 1800, "60m": 3600, "24h": 86400, "7d": 604800 };
export const windowSeconds = (w: MetricWindow): number => WINDOW_SEC[w];

/** Horário UTC curto: "09:40:30" em janelas de até 1 h; "10/04 09:40" (mês/dia) em janelas maiores. */
export function formatTs(iso: string, long = false): string {
  if (!long) return iso.slice(11, 19);
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)} ${iso.slice(11, 16)}`;
}

/** Horário das referências de evidência: "09:40" (HH:MM UTC); em janelas maiores que 1 h, "09-27T08:00". */
export const hhmm = (iso: string, long = false): string => (long ? iso.slice(5, 16) : iso.slice(11, 16));

/** "7 days", "24 h" ou "45 min". */
export function formatMinutes(min: number): string {
  if (min % 1440 === 0) return `${min / 1440} ${min === 1440 ? "day" : "days"}`;
  if (min % 60 === 0) return `${min / 60} h`;
  return `${min} min`;
}
