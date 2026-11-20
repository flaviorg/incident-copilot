// Reads runbooks/*.md, validates the frontmatter, splits by section and computes the version (content hash). Ranks with the domain's BM25.
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
  version: string; // 6 hex of the file's sha256
  section: string; // slug of the section title, e.g.: "mitigation"
  title: string; // runbook title
  heading: string; // section heading as written, e.g.: "Mitigation"
  text: string;
  services: string[];
  categories: string[];
};

// Refusal threshold (section names below use the current English slugs). 1st calibration on 2026-10-04 (Task 10, step 5) with the runbooks in this folder:
// - golden queries from bm25.unit.test.ts: refusal (tls/ingress, billing-api) = 0 (no section scores);
//   lowest accepted relevant section = 0.1830 (deploy, orders-5xx#prevention) and 0.1868 (cost, cloud-cost#prevention);
//   highest noise on the deploy query (sections of other runbooks, including the distractor) = 0.0366.
// Recalibrated on 2026-10-04 (Task 20) with the real buildRunbookQuery query (alert rule + hypothesis +
// evidence + category words, about 450 characters) over the fixtures' diagnoses:
//   deploy: orders-5xx §mitigation 0.0760, §diagnosis 0.0751, §symptoms 0.0722, §prevention 0.0663; highest noise 0.0141;
//   cost: cloud-cost §diagnosis 0.0915, §mitigation 0.0557, §symptoms 0.0404; highest noise 0.0157;
//   tls refusal (billing-api): 0.0167.
// With 0.06 the cost mitigation section (the most useful one for the planner) was left out. 0.045 sits between the highest
// measured noise or refusal on any query (0.0366) and the lowest section that must pass (0.0557).
// If the query text grows a lot (the score is normalized by the query's cap), recalibrate with these same numbers.
const RUNBOOK_MIN_NORMALIZED_SCORE = 0.045;

const EXCERPT_MAX = 400;

function requireList(data: Record<string, string | string[]>, key: string, file: string): string[] {
  const v = data[key];
  if (!Array.isArray(v) || v.length === 0) {
    throw new ValidationError(`runbook ${file}: frontmatter without list "${key}"`, [{ path: `${file}:${key}`, message: "list required" }]);
  }
  return v;
}

function requireString(data: Record<string, string | string[]>, key: string, file: string): string {
  const v = data[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ValidationError(`runbook ${file}: frontmatter without "${key}"`, [{ path: `${file}:${key}`, message: "text required" }]);
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
    if (sections.length === 0) throw new ValidationError(`runbook ${file}: no "## " section`, [{ path: file, message: "no sections" }]);
    return sections;
  }

  sections(): RunbookSection[] {
    return this.all;
  }

  /** Filters by service (or "*"), ranks by BM25 and applies the normalized threshold: below it, refuses instead of returning the least bad. */
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
