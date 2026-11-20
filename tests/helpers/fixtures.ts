// LLM fixture helpers for tests (spec 7.2, rule 10): read, derive in code and build turns.
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { FixtureFileSchema } from "../../src/llm/fixture-format.ts";
import type { FixtureFile, FixtureTurn, FixtureErrorKind } from "../../src/llm/fixture-format.ts";
import { PROJECT_ROOT } from "../../src/infra/paths.ts";

export const resolveFromRoot = (path: string): string => (isAbsolute(path) ? path : join(PROJECT_ROOT, path));

export function readFixture(path: string): FixtureFile {
  return FixtureFileSchema.parse(JSON.parse(readFileSync(resolveFromRoot(path), "utf8")));
}

/** Turn with output. Without `prompt`, inherits the anchor turn's in the patchFixture `insertBefore`. */
export function turn(id: string, when: FixtureTurn["when"], output: unknown, prompt = ""): FixtureTurn {
  return { id, prompt, when, output };
}

/** Turn with a simulated failure. Without `prompt`, inherits the anchor turn's in the patchFixture `insertBefore`. */
export function errTurn(id: string, when: FixtureTurn["when"], kind: FixtureErrorKind, prompt = ""): FixtureTurn {
  return { id, prompt, when, error: { kind } };
}

export type FixturePatch = {
  replace?: Record<string, Partial<FixtureTurn>>;
  remove?: string[];
  append?: FixtureTurn[];
  insertBefore?: Record<string, FixtureTurn[]>;
};

/** Derives one fixture from another without altering the base. A nonexistent id throws, so a typo does not pass silently. */
export function patchFixture(base: FixtureFile, p: FixturePatch): FixtureFile {
  const out = structuredClone(base);
  const ids = new Set(out.turns.map((t) => t.id));
  const need = (id: string) => {
    if (!ids.has(id)) throw new Error(`patchFixture: unknown turn ${id}`);
  };
  for (const [id, patch] of Object.entries(p.replace ?? {})) {
    need(id);
    out.turns = out.turns.map((t) => {
      if (t.id !== id) return t;
      const next: FixtureTurn = { ...t, ...structuredClone(patch) };
      if ("error" in patch) delete next.output;
      if ("output" in patch) delete next.error;
      return next;
    });
  }
  for (const id of p.remove ?? []) {
    need(id);
    out.turns = out.turns.filter((t) => t.id !== id);
  }
  for (const [anchor, inserted] of Object.entries(p.insertBefore ?? {})) {
    need(anchor);
    const idx = out.turns.findIndex((t) => t.id === anchor);
    const prompt = out.turns[idx]!.prompt;
    out.turns.splice(idx, 0, ...inserted.map((t) => ({ ...structuredClone(t), prompt: t.prompt || prompt })));
  }
  out.turns.push(...(p.append ?? []).map((t) => structuredClone(t)));
  return FixtureFileSchema.parse(out);
}
