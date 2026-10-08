// The repository's own SDD specs (Task 43; spec 9 and lessons 221505, 210745): each feature has non-goals and
// EARS acceptance criteria, and the constitution fits in 80 lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("every feature spec has non-goals and EARS criteria", () => {
  const dirs = readdirSync("specs").filter((d) => /^\d{3}-/.test(d));
  assert.equal(dirs.length, 7, `expected 7 feature specs, found ${dirs.join(", ")}`);
  for (const dir of dirs) {
    const t = readFileSync(join("specs", dir, "spec.md"), "utf8");
    assert.match(t, /^## Non-goals/m, dir);
    assert.match(t, /^## Acceptance criteria \(EARS\)/m, dir);
    assert.match(t, /\*\*AC-\d+\*\* (When|If|While|The system|The server|The API|The pre-commit hook)/, dir);
  }
  assert.ok(readFileSync("specs/constitution.md", "utf8").split("\n").length <= 80);
});

test("every acceptance criterion of the design appears in exactly one feature spec", () => {
  const owner = new Map<string, string>();
  for (const dir of readdirSync("specs").filter((d) => /^\d{3}-/.test(d))) {
    const t = readFileSync(join("specs", dir, "spec.md"), "utf8");
    for (const m of t.matchAll(/^- \*\*(AC-\d+)\*\* /gm)) {
      const id = m[1]!;
      assert.equal(owner.get(id), undefined, `${id} appears in ${owner.get(id)} and in ${dir}`);
      owner.set(id, dir);
    }
  }
  const missing = Array.from({ length: 41 }, (_, i) => `AC-${String(i + 1).padStart(2, "0")}`).filter((id) => !owner.has(id));
  assert.deepEqual(missing, []);
});
