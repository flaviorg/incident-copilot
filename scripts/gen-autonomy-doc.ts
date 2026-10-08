// Regera docs/autonomy-matrix.md a partir do catálogo (spec 7.6). Sem prompt interativo; o diff do Git é a revisão.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { renderAutonomyMatrix } from "../src/domain/autonomy/matrix-doc.ts";
import { projectPath } from "../src/infra/paths.ts";

const target = projectPath("docs", "autonomy-matrix.md");
const next = renderAutonomyMatrix();
const before = existsSync(target) ? readFileSync(target, "utf8") : null;
if (before === next) {
  console.log("docs/autonomy-matrix.md já está atualizado");
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, next);
  console.log(`docs/autonomy-matrix.md ${before === null ? "criado" : "atualizado"}`);
}
