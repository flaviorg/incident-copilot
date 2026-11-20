// Review 2026-11: human-facing text is English (constitution 7). Catches Portuguese left in string literals of the
// backend and in the human-facing config files (comments there are read by every new user).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { projectPath } from "../../src/infra/paths.ts";

const PT_WORDS = /\b(falhou|desconhecido|alerta|não|ação|ações|aprovação|incidente)\b/i;
/** Intentional: the decision parser accepts these Portuguese terms, and the message lists them. */
const ALLOWED = ["aprovar, rejeitar, sim and não"];
const PT_DIACRITICS = /ção|ções|ões|não|está/i;

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** String and template literals of a line, ignoring // comments and JSDoc lines. */
function literalsOf(line: string): string[] {
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return [];
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? "");
}

test("backend string literals carry no Portuguese", () => {
  const hits: string[] = [];
  for (const f of tsFiles(projectPath("src"))) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      for (const lit of literalsOf(line)) if (PT_WORDS.test(lit) && !ALLOWED.some((a) => lit.includes(a))) hits.push(`${f.slice(projectPath("").length)}:${i + 1}: ${lit}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("human-facing config files are in English", () => {
  const files = [".env.example", ".github/workflows/ci.yml", ".github/workflows/pages.yml", ".githooks/pre-commit", ".npmrc"];
  const hits = files.flatMap((f) => readFileSync(projectPath(f), "utf8").split("\n").map((l, i) => [f, i + 1, l] as const).filter(([, , l]) => PT_DIACRITICS.test(l)));
  assert.deepEqual(hits, []);
  const pkg = JSON.parse(readFileSync(projectPath("package.json"), "utf8")) as { description: string };
  assert.ok(!PT_DIACRITICS.test(pkg.description), pkg.description);
});

// Follow-up of the review: code comments are English too. Plain Portuguese words (with or without accents) in a
// comment fail the test; the decision parser's own files are exempt, since their comments quote the accepted words.
const PT_COMMENT_WORDS = /\b(não|nao|então|também|porque|quando|isso|está|são|pelo|pela|uma|depois|cada|mesmo|sobre|tarefa|faixa|portão|retomada|roteiro|gravação|execução|incidente|aprovação|ação|ações|regra|passo|chamada)\b/i;
const COMMENT_EXEMPT = ["src/domain/approval/parse-decision.ts", "tests/unit/parse-decision.unit.test.ts", "tests/unit/language.unit.test.ts"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (n === "node_modules" || n === "dist" || n === "public") return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.(ts|tsx|css)$/.test(p) ? [p] : [];
  });
}

/** Text of the comments on a line: a // tail outside quotes, or a line inside a block comment (starts with * or /*). */
function commentOf(line: string): string | null {
  const t = line.trim();
  if (t.startsWith("*") || t.startsWith("/*") || t.startsWith("//")) return t;
  const noStrings = line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, "\"\"");
  const i = noStrings.indexOf("//");
  return i >= 0 && !/https?:$/.test(noStrings.slice(0, i)) ? noStrings.slice(i) : null;
}

test("code comments carry no Portuguese", () => {
  const root = projectPath("");
  const hits: string[] = [];
  for (const dir of ["src", "tests", "scripts", "web/src"]) {
    for (const f of sourceFiles(projectPath(dir))) {
      const rel = f.slice(root.length).replace(/^\//, "");
      if (COMMENT_EXEMPT.includes(rel)) continue;
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        const c = commentOf(line);
        if (c !== null && PT_COMMENT_WORDS.test(c)) hits.push(`${rel}:${i + 1}: ${c.slice(0, 120)}`);
      });
    }
  }
  assert.deepEqual(hits, []);
});
