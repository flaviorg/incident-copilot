import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderAutonomyMatrix } from "../../src/domain/autonomy/matrix-doc.ts";
import { EXECUTABLE_ACTIONS, FORBIDDEN_ACTIONS } from "../../src/domain/autonomy/catalog.ts";

test("docs/autonomy-matrix.md is up to date", () => assert.equal(readFileSync("docs/autonomy-matrix.md", "utf8"), renderAutonomyMatrix()));

test("the matrix shows the 4 tiers, every action, the context rules and the generated note", () => {
  const md = renderAutonomyMatrix();
  for (const tier of ["Faixa 1", "Faixa 2", "Faixa 3", "Faixa 4"]) assert.ok(md.includes(tier), tier);
  for (const t of [...Object.keys(EXECUTABLE_ACTIONS), ...FORBIDDEN_ACTIONS, "query_metrics", "audit_cloud_inventory"]) assert.ok(md.includes(`\`${t}\``), t);
  assert.match(md, /alvo fora do escopo do incidente/);
  assert.match(md, /gerado.*não edite à mão/i);
});
