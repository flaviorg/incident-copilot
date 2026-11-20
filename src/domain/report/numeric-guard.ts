// Numeric guard (spec 5.7 and AC-23): the LLM only writes; every number in the narrative must come from a computed value,
// the timeline or the evidence. Identifiers (versions, times, dates, resource ids, CVE) are ignored. Pure.
import type { Evidence, IncidentMetrics } from "../../contracts/index.ts";

const DEFAULT_TOLERANCE = 0.005;

const THOUSANDS = /^[1-9]\d{0,2}(?:\.\d{3})+$/;

// Removed before extraction, in this order. Each match becomes a space.
const IDENTIFIER_PATTERNS: { re: RegExp; keep?: (m: string) => boolean }[] = [
  { re: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g }, // ISO 8601
  { re: /\b\d{4}-\d{2}-\d{2}\b/g }, // ISO date
  { re: /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g }, // date dd/mm(/yyyy)
  { re: /\b\d{1,2}:\d{2}(?::\d{2})?\b/g }, // time
  { re: /\bCVE-\d{4}-\d{4,}\b/gi }, // CVE
  { re: /\bv\d+(?:\.\d+)+\b/gi }, // version with v
  { re: /\b\d+\.\d+\.\d+(?:\.\d+)*\b/g, keep: (m) => THOUSANDS.test(m) }, // version without v (pt-BR thousands stay)
  { re: /\b[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+\b/g, keep: (m) => !/\d/.test(m) }, // resource id: letters + digits with - or _
];

const NUMBER = /(?<![\p{L}\d_.,])([1-9]\d{0,2}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)(?![\p{L}\d_]|[.,]\d)(\s?%)?/gu;

function parseNumber(raw: string): number {
  if (raw.includes(",")) return Number(raw.replaceAll(".", "").replace(",", "."));
  if (THOUSANDS.test(raw)) return Number(raw.replaceAll(".", ""));
  return Number(raw);
}

/** Quantities in the text in pt-BR (`11,2`, `1.240`) or en (`11.2`), with the original span (`20%`). */
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
 * Accepted values, separated by written form: `percent` for a number with "%" and `plain` for the rest. Scale equivalence
 * (9,4% and 0,094) exists only for fractions (×100 goes to `percent`) and for numbers written with "%" in the timeline
 * or in the evidence (÷100 goes to `plain`). A count of 3 or the baseline 45 do not authorize "300%" or "45%".
 */
export type AllowedNumbers = { plain: number[]; percent: number[] };

/** Each number in the text must match, within relative tolerance (default 0.5%), an accepted value of the same form. */
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
 * Computed values (metrics, including range endpoints), timeline and evidence numbers, and counts.
 * `fractions` are measured values between 0 and 1 that the narrative may cite as a percentage (e.g. error rate peak);
 * the metrics' `impactFraction` goes in that list alone.
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
