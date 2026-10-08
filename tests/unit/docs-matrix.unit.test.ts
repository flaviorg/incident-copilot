import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderAutonomyMatrix } from "../../src/domain/autonomy/matrix-doc.ts";
import { EXECUTABLE_ACTIONS, FORBIDDEN_ACTIONS } from "../../src/domain/autonomy/catalog.ts";

test("docs/autonomy-matrix.md is up to date", () => assert.equal(readFileSync("docs/autonomy-matrix.md", "utf8"), renderAutonomyMatrix()));

test("the matrix shows the 4 tiers, every action, the context rules and the generated note", () => {
  const md = renderAutonomyMatrix();
  for (const tier of ["Tier 1", "Tier 2", "Tier 3", "Tier 4"]) assert.ok(md.includes(tier), tier);
  for (const t of [...Object.keys(EXECUTABLE_ACTIONS), ...FORBIDDEN_ACTIONS, "query_metrics", "audit_cloud_inventory"]) assert.ok(md.includes(`\`${t}\``), t);
  assert.match(md, /target outside the incident scope/);
  assert.match(md, /generated.*do not edit by hand/i);
});
