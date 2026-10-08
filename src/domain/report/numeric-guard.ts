// Guarda numérico (spec 5.7 e AC-23): o LLM só redige; todo número da narrativa precisa vir de um valor calculado,
// do timeline ou das evidências. Identificadores (versões, horários, datas, ids de recurso, CVE) são ignorados. Puro.
import type { Evidence, IncidentMetrics } from "../../contracts/index.ts";

const DEFAULT_TOLERANCE = 0.005;

const THOUSANDS = /^[1-9]\d{0,2}(?:\.\d{3})+$/;

// Removidos antes da extração, nesta ordem. Cada trecho vira um espaço.
const IDENTIFIER_PATTERNS: { re: RegExp; keep?: (m: string) => boolean }[] = [
  { re: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g }, // ISO 8601
  { re: /\b\d{4}-\d{2}-\d{2}\b/g }, // data ISO
  { re: /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g }, // data dd/mm(/aaaa)
  { re: /\b\d{1,2}:\d{2}(?::\d{2})?\b/g }, // horário
  { re: /\bCVE-\d{4}-\d{4,}\b/gi }, // CVE
  { re: /\bv\d+(?:\.\d+)+\b/gi }, // versão com v
  { re: /\b\d+\.\d+\.\d+(?:\.\d+)*\b/g, keep: (m) => THOUSANDS.test(m) }, // versão sem v (milhar pt-BR fica)
  { re: /\b[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+\b/g, keep: (m) => !/\d/.test(m) }, // id de recurso: letras + dígitos com - ou _
];

const NUMBER = /(?<![\p{L}\d_.,])([1-9]\d{0,2}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)(?![\p{L}\d_]|[.,]\d)(\s?%)?/gu;

function parseNumber(raw: string): number {
  if (raw.includes(",")) return Number(raw.replaceAll(".", "").replace(",", "."));
  if (THOUSANDS.test(raw)) return Number(raw.replaceAll(".", ""));
  return Number(raw);
}

/** Quantidades do texto em pt-BR (`11,2`, `1.240`) ou en (`11.2`), com o trecho original (`20%`). */
export function extractNumbers(text: string): { raw: string; value: number }[] {
  let cleaned = text;
  for (const { re, keep } of IDENTIFIER_PATTERNS) cleaned = cleaned.replace(re, (m) => (keep?.(m) ? m : " "));
  const out: { raw: string; value: number }[] = [];
  for (const m of cleaned.matchAll(NUMBER)) {
    const value = parseNumber(m[1]!);
    if (Number.isFinite(value)) out.push({ raw: (m[1]! + (m[2] ? "%" : "")).trim(), value });
  }
  return out;
}

const close = (x: number, a: number, tol: number) => (a === 0 ? x === 0 : Math.abs(x - a) <= tol * Math.abs(a));

/**
 * Valores aceitos, separados pela forma escrita: `percent` para número com "%" e `plain` para o resto. A equivalência
 * de escala (9,4% e 0,094) só existe para frações (×100 vai para `percent`) e para números escritos com "%" na linha do
 * tempo ou nas evidências (÷100 vai para `plain`). Uma contagem 3 ou a linha de base 45 não autorizam "300%" nem "45%".
 */
export type AllowedNumbers = { plain: number[]; percent: number[] };

/** Cada número do texto precisa casar, com tolerância relativa (padrão 0,5%), com um valor aceito da mesma forma. */
export function checkNarrative(text: string, allowed: AllowedNumbers, tolerance = DEFAULT_TOLERANCE): { passed: boolean; rejected: string[] } {
  const rejected: string[] = [];
  for (const n of extractNumbers(text)) {
    const pool = n.raw.endsWith("%") ? allowed.percent : allowed.plain;
    const ok = pool.some((a) => close(n.value, a, tolerance));
    if (!ok && !rejected.includes(n.raw)) rejected.push(n.raw);
  }
  return { passed: rejected.length === 0, rejected };
}

function numbersIn(value: unknown, out: number[]): void {
  if (typeof value === "number") {
    if (Number.isFinite(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) numbersIn(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) numbersIn(v, out);
  }
}

/**
 * Valores calculados (métricas, inclusive extremos das faixas), números do timeline e das evidências, e contagens.
 * `fractions` são valores medidos entre 0 e 1 que a narrativa pode citar como porcentagem (ex.: pico da taxa de erro);
 * `impactFraction` das métricas entra nessa lista sozinho.
 */
export function collectAllowedNumbers(i: {
  metrics: IncidentMetrics; timeline: { ts: string; text: string }[]; evidence: Evidence[]; counts: number[]; fractions?: number[];
}): AllowedNumbers {
  const plain: number[] = [];
  const percent: number[] = [];
  numbersIn(i.metrics, plain);
  for (const f of [i.metrics.impactFraction, ...(i.fractions ?? [])]) {
    if (!Number.isFinite(f)) continue;
    plain.push(f);
    percent.push(f * 100);
  }
  for (const text of [...i.timeline.map((t) => t.text), ...i.evidence.map((e) => e.summary)]) {
    for (const n of extractNumbers(text)) {
      if (n.raw.endsWith("%")) {
        percent.push(n.value);
        plain.push(n.value / 100);
      } else {
        plain.push(n.value);
      }
    }
  }
  plain.push(...i.counts.filter((c) => Number.isFinite(c)));
  return { plain: [...new Set(plain)], percent: [...new Set(percent)] };
}
