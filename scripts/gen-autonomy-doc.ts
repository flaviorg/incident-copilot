// Regenerates docs/autonomy-matrix.md from the catalog (spec 7.6). No interactive prompt; the Git diff is the review.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { renderAutonomyMatrix } from "../src/domain/autonomy/matrix-doc.ts";
import { projectPath } from "../src/infra/paths.ts";

const target = projectPath("docs", "autonomy-matrix.md");
const next = renderAutonomyMatrix();
const before = existsSync(target) ? readFileSync(target, "utf8") : null;
if (before === next) {
  console.log("docs/autonomy-matrix.md is already up to date");
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, next);
  console.log(`docs/autonomy-matrix.md ${before === null ? "created" : "updated"}`);
}
