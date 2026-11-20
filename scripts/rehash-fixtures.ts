// `npm run fixtures:rehash`: updates the fake fixtures' promptHashes when a `system` changes (spec 7.2 and 7.6).
// No interactive prompt: the Git diff is the review. Prints "file old prompt -> new".
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { promptHash } from "../src/llm/prompt-hash.ts";
import type { PromptDef } from "../src/llm/provider.ts";
import { ALL_PROMPTS } from "../src/prompts/v1/index.ts";
import { PROJECT_ROOT } from "../src/infra/paths.ts";

export type HashChange = { file: string; prompt: string; old: string | null; next: string };

/** Writes the hashes of all given prompts and returns the changes; a second run returns []. */
export function rehashFixtures(files: string[], prompts: PromptDef<any, any>[]): HashChange[] {
  const changes: HashChange[] = [];
  for (const file of files) {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { promptHashes?: Record<string, string> };
    const hashes: Record<string, string> = { ...(raw.promptHashes ?? {}) };
    let changed = false;
    for (const p of prompts) {
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
  const changes = rehashFixtures(fixtureFiles(), ALL_PROMPTS);
  if (changes.length === 0) console.log("no hash changed");
  for (const c of changes) console.log(`${relative(PROJECT_ROOT, c.file)} ${c.prompt} ${c.old ?? "(missing)"} -> ${c.next}`);
}
