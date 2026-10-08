// BM25 lexical com escore normalizado para recusa por limiar (spec 4.6 e AC-25). Puro.
// idf(t) = ln(1 + (N − n + 0.5) / (n + 0.5)); teto da consulta = soma, sobre termos únicos da consulta, de idf(t) × (k1 + 1);
// normalizedScore = score / teto (sempre abaixo de 1).
import { tokenize } from "./tokenize.ts";

type Doc = { id: string; tf: Map<string, number>; length: number };

export class Bm25Index {
  private readonly docs: Doc[];
  private readonly df = new Map<string, number>();
  private readonly avgdl: number;
  private readonly k1: number;
  private readonly b: number;

  constructor(docs: { id: string; text: string }[], p: { k1: number; b: number } = { k1: 1.2, b: 0.75 }) {
    this.k1 = p.k1;
    this.b = p.b;
    this.docs = docs.map((d) => {
      const tokens = tokenize(d.text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return { id: d.id, tf, length: tokens.length };
    });
    const total = this.docs.reduce((a, d) => a + d.length, 0);
    this.avgdl = this.docs.length > 0 ? total / this.docs.length : 0;
  }

  idf(term: string): number {
    const n = this.df.get(term) ?? 0;
    const N = this.docs.length;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  }

  search(query: string, o: { minNormalizedScore: number; limit: number }): { id: string; score: number; normalizedScore: number }[] {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0 || this.docs.length === 0) return [];
    const ceiling = terms.reduce((a, t) => a + this.idf(t) * (this.k1 + 1), 0);
    const results: { id: string; score: number; normalizedScore: number }[] = [];
    for (const d of this.docs) {
      let score = 0;
      for (const t of terms) {
        const f = d.tf.get(t);
        if (!f) continue;
        const norm = this.k1 * (1 - this.b + (this.b * d.length) / (this.avgdl || 1));
        score += this.idf(t) * ((f * (this.k1 + 1)) / (f + norm));
      }
      if (score <= 0) continue;
      const normalizedScore = score / ceiling;
      if (normalizedScore >= o.minNormalizedScore) results.push({ id: d.id, score, normalizedScore });
    }
    results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return results.slice(0, o.limit);
  }
}
