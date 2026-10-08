import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "../../src/domain/retrieval/tokenize.ts";
import { Bm25Index } from "../../src/domain/retrieval/bm25.ts";
import { RunbookRepository } from "../../src/infra/runbooks/runbook-repository.ts";

test("tokenize strips accents and stopwords", () => assert.deepEqual(tokenize("Mitigação: ROLLBACK do deploy!"), ["mitigacao", "rollback", "deploy"]));
test("ranks the document with both terms first and normalizes below 1", () => {
  const idx = new Bm25Index([{ id: "a", text: "rollback deploy versão" }, { id: "b", text: "deploy pipeline" }, { id: "c", text: "custo volume" }]);
  const r = idx.search("rollback deploy", { minNormalizedScore: 0, limit: 3 });
  assert.equal(r[0]!.id, "a"); assert.ok(r.every((x) => x.normalizedScore > 0 && x.normalizedScore < 1));
  assert.ok(!r.some((x) => x.id === "c"));
});
const repo = new RunbookRepository("runbooks");
test("golden: deploy query ranks orders-5xx first and the distractor below it", () => {
  const r = repo.search({ text: "5xx acima de 5% orders-api deploy v3.8.0 TypeError PriceFormatter rollback versão anterior bad deploy", service: "orders-api" });
  assert.equal(r[0]!.runbookId, "orders-5xx-after-deploy");
  const firstPg = r.findIndex((m) => m.runbookId === "postgres-connection-exhaustion");
  assert.ok(firstPg === -1 || r.slice(0, firstPg).some((m) => m.runbookId === "orders-5xx-after-deploy"));
});
test("golden: cost query hits cloud-cost-anomaly", () => assert.equal(repo.search({ text: "custo diário volume sem anexo ip ocioso instância ociosa cost anomaly", service: null })[0]!.runbookId, "cloud-cost-anomaly"));
test("refuses below the threshold instead of returning the least bad", () =>
  assert.deepEqual(repo.search({ text: "certificado tls expirado ingress kubernetes", service: "billing-api" }), []));
test("version is stable", () => assert.match(repo.sections()[0]!.version, /^[0-9a-f]{6}$/));
test("every runbook has the four sections and excerpts stay within 400 characters", () => {
  const ids = new Set(repo.sections().map((s) => s.runbookId));
  assert.deepEqual([...ids].sort(), ["cloud-cost-anomaly", "generic-high-latency", "orders-5xx-after-deploy", "postgres-connection-exhaustion"]);
  for (const id of ids) assert.deepEqual(repo.sections().filter((s) => s.runbookId === id).map((s) => s.section), ["sintomas", "diagnostico", "mitigacao", "prevencao"]);
  const r = repo.search({ text: "rollback versão anterior deploy", service: "orders-api" });
  assert.ok(r.length > 0 && r.every((m) => m.excerpt.length <= 400));
});
