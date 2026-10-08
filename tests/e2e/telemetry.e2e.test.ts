import { test } from "node:test";
import assert from "node:assert/strict";
import { StateGraph, START, END } from "@langchain/langgraph";
import { BlackboardSchema } from "../../src/contracts/index.ts";
import { createTelemetryNode } from "../../src/graph/nodes/telemetry-node.ts";
import { runContextOf } from "../../src/graph/run-context.ts";
import { createTestContainer, countByType, initialBlackboard, nodeDeps } from "../helpers/container.ts";
import { errTurn, patchFixture, readFixture } from "../helpers/fixtures.ts";
import { runCli } from "../helpers/spawn.ts";

test("deploy diagnosis via ReAct with typed trace", async () => {
  const c = createTestContainer();
  const bb = initialBlackboard(c, "deploy-5xx-rollback");
  const out = await createTelemetryNode(nodeDeps(c))(bb);
  assert.equal(out.diagnosis!.category, "bad_deploy");
  assert.equal(out.diagnosis!.confidence, "high");
  assert.equal(out.diagnosis!.capReached, false);
  assert.equal(out.telemetryRuns, 1);
  assert.equal(out.phase, "investigating");
  const trace = c.store.listTrace(bb.incidentId);
  assert.deepEqual(countByType(trace), { thought: 4, action: 3, observation: 3, answer: 1, handoff: 1 });
  assert.deepEqual(trace.map((e) => e.seq), trace.map((_, i) => i + 1));
  const actions = c.store.listTrace(bb.incidentId, { type: "action" });
  assert.deepEqual(actions.map((e) => e.payload.tool), ["query_metrics", "list_deploys", "query_logs"]);
  assert.ok(actions.every((e) => e.payload.tier === 1 && e.agent === "telemetry_analyst"));
  const handoff = c.store.listTrace(bb.incidentId, { type: "handoff" })[0]!;
  assert.deepEqual([handoff.payload.from, handoff.payload.to], ["telemetry_analyst", "supervisor"]);
  // Pensamentos carregam o uso do LLM; o relógio simulado avança 20 s por chamada e 3 s por ferramenta.
  const thoughts = c.store.listTrace(bb.incidentId, { type: "thought" });
  assert.ok(thoughts.every((e) => e.llm?.promptVersion === "telemetry-react.v1" && e.llm.model === "fake/scripted"));
  assert.deepEqual(c.store.listTrace(bb.incidentId, { type: "observation" }).map((e) => e.ts.slice(11, 19)), ["09:42:53", "09:43:16", "09:43:39"]);
  assert.equal(c.store.listLlmCalls(bb.incidentId).length, 4);
});

test("12 steps without final: low confidence, capReached, and no GraphRecursionError inside a graph with recursionLimit 25", async () => {
  const c = createTestContainer({ fixture: "tests/fixtures/llm/react-cap.json" });
  const bb = initialBlackboard(c, "deploy-5xx-rollback");
  const g = new StateGraph(BlackboardSchema)
    .addNode("telemetry_analyst", createTelemetryNode(nodeDeps(c)))
    .addEdge(START, "telemetry_analyst")
    .addEdge("telemetry_analyst", END)
    .compile();
  const out = await g.invoke(bb, { recursionLimit: 25 });
  assert.equal(out.diagnosis!.capReached, true);
  assert.equal(out.diagnosis!.confidence, "low");
  assert.match(out.diagnosis!.hypothesis, /12 steps/);
  const obs = c.store.listTrace(bb.incidentId, { type: "observation" });
  assert.equal(obs.length, 12);
  assert.match(obs[2]!.payload.summary, /unknown tool/);
  assert.equal(obs[2]!.payload.ok, false);
  assert.match(obs[3]!.payload.summary, /invalid arguments/);
  assert.equal(obs[3]!.payload.ok, false);
  assert.ok(out.diagnosis!.evidence.length >= 1 && out.diagnosis!.evidence.length <= 8);
  assert.equal(c.store.listTrace(bb.incidentId, { type: "answer" })[0]!.payload.kind, "diagnosis");
});

test("LLM failure becomes llm_unavailable escalation", async () => {
  const fixture = patchFixture(readFixture("fixtures/llm/deploy-5xx-rollback.json"), {
    insertBefore: { "tel-1": [errTurn("e1", { run: 1, step: 1 }, "server_error"), errTurn("e2", { run: 1, step: 1 }, "server_error")] },
  });
  const c = createTestContainer({ fixture });
  const out = await createTelemetryNode(nodeDeps(c))(initialBlackboard(c, "deploy-5xx-rollback"));
  assert.equal(out.escalation!.reason, "llm_unavailable");
  assert.equal(out.diagnosis, undefined);
  assert.deepEqual(c.fake.consumedIds(), ["e1", "e2"]);
});

test("trace sink numbers, redacts and clips events; run context carries the request id", async () => {
  const c = createTestContainer();
  const bb = initialBlackboard(c, "deploy-5xx-rollback");
  const ctx = runContextOf(bb, { configurable: { requestId: "req-7" } });
  const a = c.trace.emit(ctx, "system", { type: "thought", payload: { text: `token ${"test-token-0123456789"} ${"x".repeat(2000)}` } });
  const b = c.trace.emit(ctx, "system", { type: "answer", payload: { kind: "escalation", text: "ok" } });
  assert.deepEqual([a.seq, b.seq], [1, 2]);
  assert.equal(a.id, `${bb.incidentId}:1`);
  assert.equal(a.requestId, "req-7");
  assert.ok(a.type === "thought" && a.payload.text.length === 1000 && a.payload.text.includes("[REDACTED]") && !a.payload.text.includes("test-token"));
  assert.equal(c.store.listTrace(bb.incidentId).length, 2);
});

test("diagnose CLI prints the ReAct trace", async () => {
  const r = await runCli(["diagnose", "--scenario", "deploy-5xx-rollback"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /think/);
  assert.match(r.stdout, /query_metrics/);
  assert.match(r.stdout, /obs/);
  assert.match(r.stdout, /bad_deploy/);
});
