// Varredura de segredos do repositório (Tarefa 44; spec 6.6 e AC-41). Os valores positivos são montados em tempo de
// execução, para o próprio arquivo de teste não casar na varredura do repositório.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { listProjectFiles, scanProject, scanText } from "../../scripts/check-secrets.ts";

test("positives are found", () => {
  assert.equal(scanText("OPENROUTER_API_KEY=sk-or-v1-" + "a".repeat(30), "x").length, 1);
  assert.equal(scanText("APPROVAL_TOKEN" + "=abcdefgh123", "x").length, 1);
});

test("ordinary words are not secrets", () => assert.deepEqual(scanText("task-runner disk-usage risk-score sk-short APPROVAL_TOKEN=", "x"), []));

test("the repository is clean", () => {
  for (const f of listProjectFiles(".")) assert.deepEqual(scanText(readFileSync(f, "utf8"), f), [], f);
});

test("findings carry path and line, never the value", () => {
  const value = "sk-or-v1-" + "b".repeat(32);
  const found = scanText(["primeira linha", `chave: ${value}`].join("\n"), "docs/x.md");
  assert.deepEqual(found.map((f) => [f.path, f.line]), [["docs/x.md", 2]]);
  assert.ok(!JSON.stringify(found).includes(value));
});

test("generated and ignored paths are skipped", () => {
  const files = listProjectFiles(".");
  for (const prefix of ["node_modules/", "web/node_modules/", "web/dist/", "web/public/demo/", "reports/", "coverage/", ".git/"]) {
    assert.ok(!files.some((f) => f.startsWith(prefix)), prefix);
  }
  assert.ok(!files.some((f) => /^data\/.*\.db/.test(f)), "data/*.db*");
  assert.ok(files.includes("package.json") && files.includes("src/config.ts"));
});

// Revisão final: o .env local (no .gitignore) é o caminho documentado para usar o modelo real e não pode quebrar o
// pre-commit. Ele só entra na varredura se estiver rastreado pelo Git.
function projectWithLocalEnv(): string {
  const root = mkdtempSync(join(tmpdir(), "ic-secrets-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, ".env.example"), "OPENROUTER_API_KEY=\nAPPROVAL_TOKEN=\n");
  writeFileSync(join(root, ".env"), ["OPENROUTER_API_KEY=sk-or-v1-" + "c".repeat(40), "APPROVAL_TOKEN" + "=local-dev-token-1234"].join("\n"));
  return root;
}

test("a gitignored local .env is skipped, .env.example is still scanned", () => {
  const root = projectWithLocalEnv();
  try {
    const rel = listProjectFiles(root, { isTracked: () => false }).map((f) => relative(root, f));
    assert.ok(!rel.includes(".env"), ".env");
    assert.ok(rel.includes(".env.example") && rel.includes(join("src", "a.ts")));
    assert.deepEqual(scanProject(root, { isTracked: () => false }).findings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a local .env tracked by Git is scanned and reported", () => {
  const root = projectWithLocalEnv();
  try {
    const found = scanProject(root, { isTracked: (rel) => rel === ".env" }).findings;
    assert.deepEqual(found.map((f) => [f.path, f.line]), [[".env", 1], [".env", 2]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
