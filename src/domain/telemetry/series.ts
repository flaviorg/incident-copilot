// Séries determinísticas a partir de especificação com PRNG semeado (spec 7.3). Puro.
import type { MetricName, SeriesPoint, SeriesSegment, SeriesSpec } from "../../contracts/index.ts";

/** PRNG mulberry32: mesma semente, mesma sequência em [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Métricas que são frações (presas em [0, 1]); as demais são presas em >= 0. */
const FRACTION_METRICS: readonly MetricName[] = ["http_5xx_rate"];
export const clampFor = (metric: MetricName): "unit" | "nonnegative" => (FRACTION_METRICS.includes(metric) ? "unit" : "nonnegative");

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

function segmentValue(s: SeriesSegment, t: number): number {
  if (s.kind === "constant") return s.value;
  const f = (t - s.fromSec) / (s.toSec - s.fromSec);
  return s.startValue + (s.endValue - s.startValue) * Math.min(1, Math.max(0, f));
}

function baseValueAt(segments: readonly SeriesSegment[], t: number): number {
  // Segmento que contém t em [fromSec, toSec); o último instante pertence ao segmento que termina nele.
  const inside = segments.find((s) => s.fromSec <= t && t < s.toSec) ?? segments.find((s) => s.toSec === t);
  if (inside) return segmentValue(inside, t);
  // Fora de todos: antes do primeiro, o valor inicial dele; depois, o final do último que já terminou.
  const sorted = [...segments].sort((a, b) => a.fromSec - b.fromSec);
  const first = sorted[0]!;
  if (t < first.fromSec) return segmentValue(first, first.fromSec);
  const ended = sorted.filter((s) => s.toSec <= t).at(-1) ?? first;
  return segmentValue(ended, ended.toSec);
}

/** Pontos a cada `resolutionSec` de 0 a `durationSec`, inclusive o ponto final. Ruído: value + (rng() * 2 - 1) * amplitude. */
export function materializeSeries(
  spec: SeriesSpec,
  start: Date,
  resolutionSec: number,
  durationSec: number,
  o: { clamp?: "unit" | "nonnegative" } = {},
): SeriesPoint[] {
  if (resolutionSec <= 0) throw new RangeError("resolutionSec precisa ser positivo");
  const rng = spec.noise ? mulberry32(spec.noise.seed) : null;
  const amplitude = spec.noise?.amplitude ?? 0;
  const max = o.clamp === "unit" ? 1 : Number.POSITIVE_INFINITY;
  const points: SeriesPoint[] = [];
  const startMs = start.getTime();
  for (let t = 0; t <= durationSec; t += resolutionSec) {
    let v = baseValueAt(spec.segments, t);
    if (rng) v += (rng() * 2 - 1) * amplitude;
    v = Math.min(max, Math.max(0, v));
    points.push({ ts: new Date(startMs + t * 1000).toISOString(), value: round6(v) });
  }
  return points;
}

/** ts da primeira amostra acima do limiar, ou null. */
export function firstViolation(points: readonly SeriesPoint[], threshold: number): string | null {
  return points.find((p) => p.value > threshold)?.ts ?? null;
}

/** Média das amostras com ts em [fromIso, toIso], ou null se não houver nenhuma. */
export function meanBetween(points: readonly SeriesPoint[], fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  const inside = points.filter((p) => {
    const t = Date.parse(p.ts);
    return t >= from && t <= to;
  });
  if (inside.length === 0) return null;
  return inside.reduce((acc, p) => acc + p.value, 0) / inside.length;
}

/** Amostras com ts em [fromIso, toIso]. */
export function pointsBetween(points: readonly SeriesPoint[], fromIso: string, toIso: string): SeriesPoint[] {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  return points.filter((p) => {
    const t = Date.parse(p.ts);
    return t >= from && t <= to;
  });
}
