// Lê runbooks/*.md, valida o frontmatter, quebra por seção e calcula a versão (hash do conteúdo). Ranqueia com o BM25 do domínio.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunbookMatch } from "../../contracts/index.ts";
import { Bm25Index } from "../../domain/retrieval/bm25.ts";
import { FrontmatterError, parseFrontmatter } from "../../domain/retrieval/frontmatter.ts";
import { slugify } from "../../domain/retrieval/tokenize.ts";
import { ValidationError } from "../../domain/errors.ts";
import { sha256Hex } from "../crypto.ts";

export type RunbookSection = {
  runbookId: string;
  version: string; // 6 hex do sha256 do arquivo
  section: string; // slug do título da seção, ex.: "mitigacao"
  title: string; // título do runbook
  heading: string; // título da seção como escrito, ex.: "Mitigação"
  text: string;
  services: string[];
  categories: string[];
};

// Limiar de recusa. 1ª calibração em 2026-10-04 (Tarefa 10, passo 5) com os runbooks desta pasta:
// - consultas golden do bm25.unit.test.ts: recusa (tls/ingress, billing-api) = 0 (nenhuma seção pontua);
//   menor seção relevante aceita = 0,1830 (deploy, orders-5xx#prevencao) e 0,1868 (custo, cloud-cost#prevencao);
//   maior ruído na consulta de deploy (seções de outros runbooks, inclusive o distrator) = 0,0366.
// Recalibrado em 2026-10-04 (Tarefa 20) com a consulta real de buildRunbookQuery (regra do alerta + hipótese +
// evidências + palavras da categoria, cerca de 450 caracteres) sobre os diagnósticos das fixtures:
//   deploy: orders-5xx §mitigacao 0,0760, §diagnostico 0,0751, §sintomas 0,0722, §prevencao 0,0663; maior ruído 0,0141;
//   custo: cloud-cost §diagnostico 0,0915, §mitigacao 0,0557, §sintomas 0,0404; maior ruído 0,0157;
//   recusa tls (billing-api): 0,0167.
// Com 0,06 a seção de mitigação do custo (a mais útil para o planejador) ficava de fora. 0,045 fica entre o maior
// ruído ou recusa medido em qualquer consulta (0,0366) e a menor seção que precisa passar (0,0557).
// Se o texto da consulta crescer muito (o escore é normalizado pelo teto da consulta), recalibre com estes mesmos números.
const RUNBOOK_MIN_NORMALIZED_SCORE = 0.045;

const EXCERPT_MAX = 400;

function requireList(data: Record<string, string | string[]>, key: string, file: string): string[] {
  const v = data[key];
  if (!Array.isArray(v) || v.length === 0) {
    throw new ValidationError(`runbook ${file}: frontmatter sem lista "${key}"`, [{ path: `${file}:${key}`, message: "lista obrigatória" }]);
  }
  return v;
}

function requireString(data: Record<string, string | string[]>, key: string, file: string): string {
  const v = data[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ValidationError(`runbook ${file}: frontmatter sem "${key}"`, [{ path: `${file}:${key}`, message: "texto obrigatório" }]);
  }
  return v;
}

function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= EXCERPT_MAX ? flat : flat.slice(0, EXCERPT_MAX - 1) + "…";
}

export class RunbookRepository {
  private readonly all: RunbookSection[];
  private readonly index: Bm25Index;

  constructor(dir: string) {
    const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    this.all = files.flatMap((file) => this.parseFile(file, readFileSync(join(dir, file), "utf8")));
    this.index = new Bm25Index(this.all.map((s) => ({ id: `${s.runbookId}#${s.section}`, text: `${s.title}\n${s.heading}\n${s.text}` })));
  }

  private parseFile(file: string, content: string): RunbookSection[] {
    let parsed: ReturnType<typeof parseFrontmatter>;
    try {
      parsed = parseFrontmatter(content);
    } catch (e) {
      if (e instanceof FrontmatterError) throw new ValidationError(`runbook ${file}: ${e.message}`, [{ path: `${file}:${e.line}`, message: e.message }]);
      throw e;
    }
    const runbookId = requireString(parsed.data, "id", file);
    const title = requireString(parsed.data, "title", file);
    const services = requireList(parsed.data, "service", file);
    const categories = requireList(parsed.data, "category", file);
    const version = sha256Hex(content).slice(0, 6);

    const sections: RunbookSection[] = [];
    let current: { heading: string; lines: string[] } | null = null;
    const flush = () => {
      if (current) sections.push({ runbookId, version, section: slugify(current.heading), title, heading: current.heading, text: current.lines.join("\n").trim(), services, categories });
    };
    for (const line of parsed.body.split("\n")) {
      const h = /^##\s+(.+?)\s*$/.exec(line);
      if (h) {
        flush();
        current = { heading: h[1]!, lines: [] };
      } else if (current) {
        current.lines.push(line);
      }
    }
    flush();
    if (sections.length === 0) throw new ValidationError(`runbook ${file}: nenhuma seção "## "`, [{ path: file, message: "sem seções" }]);
    return sections;
  }

  sections(): RunbookSection[] {
    return this.all;
  }

  /** Filtra por serviço (ou "*"), ranqueia por BM25 e aplica o limiar normalizado: abaixo dele, recusa em vez do menos ruim. */
  search(q: { text: string; service: string | null }, o: { limit?: number; minNormalizedScore?: number } = {}): RunbookMatch[] {
    const limit = o.limit ?? 3;
    const allowed = new Map<string, RunbookSection>(
      this.all
        .filter((s) => s.services.includes("*") || (q.service !== null && s.services.includes(q.service)))
        .map((s): [string, RunbookSection] => [`${s.runbookId}#${s.section}`, s]),
    );
    return this.index
      .search(q.text, { minNormalizedScore: o.minNormalizedScore ?? RUNBOOK_MIN_NORMALIZED_SCORE, limit: this.all.length })
      .filter((r) => allowed.has(r.id))
      .slice(0, limit)
      .map((r) => {
        const s = allowed.get(r.id)!;
        return { runbookId: s.runbookId, version: s.version, section: s.section, score: r.score, normalizedScore: r.normalizedScore, excerpt: excerptOf(s.text) };
      });
  }
}
