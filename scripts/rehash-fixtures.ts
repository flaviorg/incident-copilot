// `npm run fixtures:rehash`: updates the fake fixtures' promptHashes when a `system` changes (spec 7.2 and 7.6).
// No interactive prompt: the Git diff is the review. Prints "file old prompt -> new".
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { promptHash } from "../src/llm/prompt-hash.ts";
import type { PromptDef } from "../src/llm/provider.ts";
import { ALL_PROMPTS, FIX_PROMPTS } from "../src/prompts/v1/index.ts";
import { PROJECT_ROOT } from "../src/infra/paths.ts";

export type HashChange = { file: string; prompt: string; old: string | null; next: string };

const FIX_VERSIONS = new Set(FIX_PROMPTS.map((p) => p.version));

/**
 * Writes the hashes of all given prompts and returns the changes; a second run returns [].
 * A FIX_PROMPTS hash goes only into a file with a turn of that prompt (or one that already lists it), so the scenario
 * fixtures stay byte-identical (spec 009, decision 18).
 */
export function rehashFixtures(files: string[], prompts: PromptDef<any, any>[]): HashChange[] {
  const changes: HashChange[] = [];
  for (const file of files) {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { promptHashes?: Record<string, string>; turns?: { prompt?: unknown }[] };
    const hashes: Record<string, string> = { ...(raw.promptHashes ?? {}) };
    const used = new Set((raw.turns ?? []).map((t) => t.prompt));
    let changed = false;
    for (const p of prompts) {
      if (FIX_VERSIONS.has(p.version) && !used.has(p.version) && !(p.version in hashes)) continue;
      const next = promptHash(p);
      const old = hashes[p.version] ?? null;
      if (old !== next) {
        hashes[p.version] = next;
        changes.push({ file, prompt: p.version, old, next });
        changed = true;
      }
    }
    if (changed) writeFileSync(file, JSON.stringify({ ...raw, promptHashes: hashes }, null, 2) + "\n");
  }
  return changes;
}

export function fixtureFiles(root = PROJECT_ROOT): string[] {
  return [join(root, "fixtures", "llm"), join(root, "tests", "fixtures", "llm")]
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => join(dir, f)));
}

if (import.meta.main) {
  const changes = rehashFixtures(fixtureFiles(), [...ALL_PROMPTS, ...FIX_PROMPTS]);
  if (changes.length === 0) console.log("no hash changed");
  for (const c of changes) console.log(`${relative(PROJECT_ROOT, c.file)} ${c.prompt} ${c.old ?? "(missing)"} -> ${c.next}`);
}
