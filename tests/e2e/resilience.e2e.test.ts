// LLM indisponível e timeout de execução pela API (spec 6.1 e 6.2; AC-29 e AC-30).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../../src/http/server.ts";
import { createTestContainer } from "../helpers/container.ts";
import { errTurn, patchFixture, readFixture } from "../helpers/fixtures.ts";

type App = ReturnType<typeof buildServer>;
const post = (a: App, url: string, payload: unknown) => a.inject({ method: "POST", url, payload: payload as object });
const deploy = () => readFixture("fixtures/llm/deploy-5xx-rollback.json");

test("503 llm_unavailable and the incident is stored as escalated with a partial report", async () => {
  const fx = patchFixture(deploy(), {
    insertBefore: { "sup-1": [errTurn("e1", { hasDiagnosis: false }, "server_error"), errTurn("e2", { hasDiagnosis: false }, "server_error")] },
  });
  const c = createTestContainer({ fixture: fx });
  const r = await post(buildServer(c), "/incidents", { scenarioId: "deploy-5xx-rollback" });
  assert.deepEqual([r.statusCode, r.json().error.code], [503, "llm_unavailable"]);
  assert.ok(r.json().error.requestId);
  assert.equal(c.incidents.list({ limit: 5 })[0]!.status, "escalated");
  assert.equal(c.incidents.postmortem("INC-0001").status, "partial");
});

test("504 run_timeout with a real abort", async () => {
  const fx = patchFixture(deploy(), { replace: { "sup-1": { delayMs: 200 } } });
  const c = createTestContainer({ fixture: fx, runTimeoutMs: 50 });
  const t0 = Date.now();
  const r = await post(buildServer(c), "/incidents", { scenarioId: "deploy-5xx-rollback" });
  assert.deepEqual([r.statusCode, r.json().error.code], [504, "run_timeout"]);
  assert.ok(Date.now() - t0 < 1000, "the response does not wait for the slow turn to finish");
  assert.equal(c.incidents.get("INC-0001").incident.escalation!.reason, "timeout");
  assert.equal(c.incidents.postmortem("INC-0001").status, "partial");
});

test("LLM_TIMEOUT_MS turns a slow call into a failed attempt", async () => {
  const base = deploy();
  const sup1 = base.turns.find((t) => t.id === "sup-1")!;
  const fx = patchFixture(base, { replace: { "sup-1": { delayMs: 200 } }, insertBefore: { "sup-1": [{ ...sup1, id: "sup-1-slow", delayMs: 200 }] } });
  const c = createTestContainer({ fixture: fx, llmTimeoutMs: 20 });
  const r = await post(buildServer(c), "/incidents", { scenarioId: "deploy-5xx-rollback" });
  assert.deepEqual([r.statusCode, r.json().error.code], [503, "llm_unavailable"]);
  // Uma chamada lógica registrada (as 2 tentativas ficam dentro dela), que falhou por timeout; os 2 turnos lentos foram usados.
  const calls = c.store.listLlmCalls("INC-0001");
  assert.deepEqual(calls.map((x) => [x.promptVersion, x.success, x.errorKind]), [["supervisor.v1", false, "timeout"]]);
  assert.deepEqual(c.fake.consumedIds(), ["sup-1-slow", "sup-1"]);
  assert.equal(c.incidents.get("INC-0001").incident.escalation!.reason, "llm_unavailable");
});

test("RUN_TIMEOUT_MS is a ceiling even when the run never yields to the event loop (fake without delay)", async () => {
  // Sem delayMs, o fake responde em microtarefas e o timer de AbortSignal.timeout nunca roda; o prazo é conferido pelo relógio.
  const c = createTestContainer({ runTimeoutMs: 1 });
  const r = await post(buildServer(c), "/incidents", { scenarioId: "deploy-5xx-rollback" });
  assert.deepEqual([r.statusCode, r.json().error.code], [504, "run_timeout"]);
  assert.equal(c.incidents.get("INC-0001").incident.escalation!.reason, "timeout");
  assert.equal(c.incidents.postmortem("INC-0001").status, "partial");
  assert.ok(c.logs.some((l) => l.includes("\"run_escalated\"")), "the escalation outside the graph is logged");
});
