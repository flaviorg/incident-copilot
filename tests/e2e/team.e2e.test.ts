import { test } from "node:test";
import assert from "node:assert/strict";
import { IncidentViewSchema } from "../../src/contracts/index.ts";
import type { Diagnosis } from "../../src/contracts/index.ts";
import { ConflictError, LlmUnavailableError, NotFoundError, RunTimeoutError } from "../../src/domain/errors.ts";
import { openIncidentRecord } from "../../src/app/incident-setup.ts";
import { createTestContainer } from "../helpers/container.ts";
import { errTurn, patchFixture, readFixture, turn } from "../helpers/fixtures.ts";

const handoffs = (c: ReturnType<typeof createTestContainer>, id: string) =>
  c.store.listTrace(id, { type: "handoff" }).map((e) => `${e.payload.from}>${e.payload.to}`);

test("deploy: handoff sequence up to the gate, audited plan and a postmortem", async () => {
  const c = createTestContainer();
  const v = await c.incidents.open({ scenarioId: "deploy-5xx-rollback" }, { requestId: null });
  assert.equal(IncidentViewSchema.safeParse(v).success, true);
  assert.deepEqual(handoffs(c, v.incident.id).slice(0, 8), [
    "supervisor>telemetry_analyst", "telemetry_analyst>supervisor", "supervisor>runbook_retriever", "runbook_retriever>supervisor",
    "supervisor>remediation_planner", "remediation_planner>auditor", "auditor>supervisor", "supervisor>gate",
  ]);
  assert.equal(v.plan!.steps.length, 3);
  assert.equal(v.audit!.verdict, "approve");
  assert.equal(v.diagnosis!.category, "bad_deploy");
  assert.equal(v.runbookMatches[0]!.runbookId, "orders-5xx-after-deploy");
  assert.equal(v.traceCount, c.store.listTrace(v.incident.id).length);
  // Roteiro até o portão, em ordem. O portão não chama o LLM; o que vem depois dele (aprovação, relatório) muda com as
  // tarefas 27 a 30, então este teste não afirma o status final do caminho feliz.
  assert.deepEqual(c.fake.consumedIds(), ["sup-1", "tel-1", "tel-2", "tel-3", "tel-4", "sup-2", "sup-3", "plan-0", "aud-0", "sup-4"]);
  // Uma linha em runs por invocação, com início, fim e desfecho.
  const runs = c.store.listRuns(v.incident.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.outcome, v.incident.status);
  assert.notEqual(runs[0]!.endedAt, null);
  // O blackboard persistido é o último estado da invocação.
  const saved = c.store.loadBlackboard(v.incident.id);
  assert.equal(saved.version, 2);
  assert.equal(saved.blackboard.runId, runs[0]!.id);
  assert.equal(saved.blackboard.supervisor.iterations, 4);
});

test("cost: Reflection sends the plan back once", async () => {
  const c = createTestContainer();
  const v = await c.incidents.open({ scenarioId: "cost-anomaly" }, { requestId: null });
  assert.deepEqual(c.store.listTrace(v.incident.id, { type: "plan" }).map((e) => e.payload.revision), [0, 1]);
  assert.deepEqual(c.store.listTrace(v.incident.id, { type: "critique" }).filter((e) => e.payload.by === "auditor").map((e) => e.payload.verdict), ["revise", "approve"]);
  assert.equal(v.planRevision, 1);
  assert.equal(v.plan!.steps.some((s) => s.actionType === "create_volume_snapshot"), true);
  assert.deepEqual(handoffs(c, v.incident.id).slice(4, 10), [
    "supervisor>remediation_planner", "remediation_planner>auditor", "auditor>remediation_planner",
    "remediation_planner>auditor", "auditor>supervisor", "supervisor>gate",
  ]);
  assert.deepEqual(c.fake.consumedIds(), ["sup-1", "tel-1", "tel-2", "tel-3", "sup-2", "sup-3", "plan-0", "aud-0", "plan-1", "aud-1", "sup-4"]);
});

test("team cap (limit 3) escalates with a partial template report", async () => {
  const c = createTestContainer({ limits: { teamMaxIterations: 3 } });
  const v = await c.incidents.open({ scenarioId: "deploy-5xx-rollback" }, { requestId: null });
  assert.equal(v.incident.status, "escalated");
  assert.equal(v.incident.escalation!.reason, "team_cap_reached");
  const pm = c.incidents.postmortem(v.incident.id);
  assert.equal(pm.status, "partial");
  assert.equal(pm.generatedBy.model, "template");
  assert.equal(c.fake.calls().filter((x) => x.prompt === "supervisor.v1").length, 3);
  assert.equal(c.fake.calls().some((x) => x.prompt === "postmortem.v1"), false);
  assert.match(c.incidents.postmortemMarkdown(v.incident.id), /^# /);
  const escalated = c.store.listAudit(v.incident.id).filter((a) => a.event === "incident_escalated");
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0]!.details.reason, "team_cap_reached");
});

test("recursion limit (5) escalates and keeps the last state", async () => {
  const c = createTestContainer({ limits: { recursionLimit: 5 } });
  const v = await c.incidents.open({ scenarioId: "deploy-5xx-rollback" }, { requestId: "req-rec" });
  assert.equal(v.incident.status, "escalated");
  assert.equal(v.incident.escalation!.reason, "recursion_limit");
  const saved = c.store.loadBlackboard(v.incident.id).blackboard;
  assert.notEqual(saved.diagnosis, null);
  assert.equal(saved.runbookSearchDone, true);
  assert.equal(saved.postmortem!.status, "partial");
  assert.ok(c.store.listTrace(v.incident.id).length > 0);
  // O escalonamento direto (fora do grafo) também grava answer do sistema e auditoria com o requestId.
  assert.equal(c.store.listTrace(v.incident.id, { type: "answer" }).filter((e) => e.payload.kind === "escalation").length, 1);
  const row = c.store.listAudit(v.incident.id).find((a) => a.event === "incident_escalated")!;
  assert.deepEqual([row.details.reason, row.details.requestId], ["recursion_limit", "req-rec"]);
  assert.ok(c.store.listTrace(v.incident.id).every((e) => e.requestId === "req-rec"));
});

test("react cap escalates without calling the planner", async () => {
  const c = createTestContainer({ fixture: "tests/fixtures/llm/react-cap.json" });
  const v = await c.incidents.open({ scenarioId: "deploy-5xx-rollback" }, { requestId: null });
  assert.equal(v.incident.escalation!.reason, "react_cap_low_confidence");
  assert.equal(c.fake.calls().some((x) => x.prompt === "planner.v1"), false);
  assert.equal(c.fake.calls().filter((x) => x.prompt === "supervisor.v1").length, 1);
  assert.equal(v.diagnosis!.capReached, true);
  c.fake.assertAllConsumed({ scenarioId: "deploy-5xx-rollback" });
});

test("low confidence after two runs escalates as low_confidence_diagnosis", async () => {
  const base = readFixture("fixtures/llm/deploy-5xx-rollback.json");
  const tel4 = base.turns.find((t) => t.id === "tel-4")!;
  const final = tel4.output as { kind: "final"; thought: string; diagnosis: Omit<Diagnosis, "capReached"> };
  const weak = { ...final, diagnosis: { ...final.diagnosis, confidence: "low" as const, category: "unknown" as const } };
  const fixture = patchFixture(base, {
    replace: { "tel-4": { output: weak } },
    insertBefore: {
      "sup-2": [turn("sup-2b", { hasDiagnosis: true }, { next: "telemetry_analyst", brief: "Confirm the correlation with the deploy", reason: "Low-confidence diagnosis" })],
    },
    append: [
      turn("tel2-1", { run: 2, step: 1 }, { kind: "action", thought: "I check the P99 latency over the same interval.", tool: "query_metrics", args: { service: "orders-api", metric: "p99_latency_ms", window: "30m" } }, "telemetry-react.v1"),
      turn("tel2-2", { run: 2, step: 2 }, { ...weak, thought: "Still no signal that confirms the cause." }, "telemetry-react.v1"),
    ],
  });
  const c = createTestContainer({ fixture });
  const v = await c.incidents.open({ scenarioId: "deploy-5xx-rollback" }, { requestId: null });
  assert.equal(v.incident.escalation!.reason, "low_confidence_diagnosis");
  assert.equal(v.diagnosis!.confidence, "low");
  assert.equal(c.fake.calls().filter((x) => x.prompt === "supervisor.v1").length, 2);
  assert.equal(c.fake.calls().some((x) => x.prompt === "planner.v1"), false);
  assert.equal(c.store.loadBlackboard(v.incident.id).blackboard.telemetryRuns, 2);
});

test("guard coercion keeps the flow going", async () => {
  const c = createTestContainer({ fixture: "tests/fixtures/llm/guard-coercion.json" });
  const v = await c.incidents.open({ scenarioId: "deploy-5xx-rollback" }, { requestId: null });
  const coerced = c.store.listTrace(v.incident.id, { type: "critique" }).filter((e) => e.payload.by === "supervisor_guard");
  assert.deepEqual(coerced.map((e) => e.payload.verdict), ["coerced"]);
  assert.equal(c.fake.calls().some((x) => x.prompt === "planner.v1"), true);
  assert.equal(handoffs(c, v.incident.id)[0], "supervisor>telemetry_analyst");
  assert.equal(c.store.loadBlackboard(v.incident.id).blackboard.supervisor.history[0]!.coerced, true);
  assert.equal(v.audit!.verdict, "approve");
});

test("every supervisor decision and specialist return has a handoff", async () => {
  const c = createTestContainer();
  const v = await c.incidents.open({ scenarioId: "deploy-5xx-rollback" }, { requestId: null });
  const bb = c.store.loadBlackboard(v.incident.id).blackboard;
  const hs = handoffs(c, v.incident.id);
  const fromSupervisor = hs.filter((h) => h.startsWith("supervisor>"));
  assert.equal(fromSupervisor.length, bb.supervisor.iterations);
  assert.deepEqual(fromSupervisor, bb.supervisor.history.map((h) => `supervisor>${h.to}`));
  for (const specialist of ["telemetry_analyst", "runbook_retriever", "remediation_planner", "auditor"]) {
    const called = fromSupervisor.filter((h) => h === `supervisor>${specialist}`).length + hs.filter((h) => h.endsWith(`>${specialist}`) && !h.startsWith("supervisor>")).length;
    const returned = hs.filter((h) => h.startsWith(`${specialist}>`)).length;
    assert.equal(returned, called, specialist);
  }
});

test("incident status is derived and persisted; reads go through the service", async () => {
  // Teto de equipe 3: escala antes do portão, então o desfecho não depende das tarefas 27 a 29.
  const c = createTestContainer({ limits: { teamMaxIterations: 3 } });
  const v = await c.incidents.open({ scenarioId: "deploy-5xx-rollback", title: "5xx spike" }, { requestId: "req-1" });
  assert.equal(v.incident.status, "escalated");
  assert.equal(v.incident.escalation!.reason, "team_cap_reached");
  assert.equal(v.incident.title, "5xx spike");
  // Texto para pessoas: motivo e detalhe numa frase só, pontuada.
  const answer = c.store.listTrace(v.incident.id, { type: "answer" }).find((e) => e.payload.kind === "escalation")!;
  assert.equal(answer.payload.text, "Incident escalated to humans: team iteration cap reached (supervisor invoked 4 times; the team cap is 3).");
  assert.match(c.incidents.postmortem(v.incident.id).summary, /^Incident escalated to humans: team iteration cap reached \([^)]+\)\. This report is partial/);
  assert.equal(c.store.getIncident(v.incident.id)!.status, "escalated");
  assert.deepEqual(c.incidents.get(v.incident.id), v);
  assert.deepEqual(c.incidents.list({ status: "escalated", limit: 5 }).map((s) => s.id), [v.incident.id]);
  assert.deepEqual(c.incidents.list({ status: "resolved", limit: 5 }), []);
  assert.equal(c.incidents.trace(v.incident.id, { type: "plan" }).length, 1);
  const audit = c.incidents.audit(v.incident.id);
  assert.deepEqual(audit.map((a) => a.event), ["incident_opened", "incident_escalated"]);
  assert.deepEqual(Object.keys(audit[0]!).sort(), ["actor", "details", "event", "hash", "id", "prevHash", "tier", "ts"]);
  assert.equal(audit[0]!.details.requestId, "req-1");
  assert.throws(() => c.incidents.get("INC-9999"), (e) => e instanceof NotFoundError);
  assert.throws(() => c.incidents.trace("INC-9999"), (e) => e instanceof NotFoundError);
  // Retomada só vale para um incidente na fase resume (marcada pelo ApprovalService na Tarefa 29).
  await assert.rejects(c.incidents.resume(v.incident.id, { requestId: null }), (e) => e instanceof ConflictError && e.code === "incident_not_accepting");
});

test("postmortem before the report is a conflict", () => {
  const c = createTestContainer();
  // Incidente aberto sem execução do grafo: ainda sem relatório.
  const { incident } = openIncidentRecord(
    { store: c.store, scenarios: c.scenarios, clock: c.clock, ids: c.ids, initialWorld: (s) => c.infra.initialWorld(s) },
    { scenarioId: "deploy-5xx-rollback" },
    { requestId: null },
  );
  assert.throws(() => c.incidents.postmortem(incident.id), (e) => e instanceof ConflictError && e.code === "postmortem_not_ready");
  assert.throws(() => c.incidents.postmortemMarkdown(incident.id), (e) => e instanceof ConflictError && e.code === "postmortem_not_ready");
  assert.equal(c.incidents.get(incident.id).incident.status, "open");
  assert.equal(c.incidents.get(incident.id).postmortemReady, false);
});

test("open raises LlmUnavailableError only after persisting the escalated incident", async () => {
  const fixture = patchFixture(readFixture("fixtures/llm/deploy-5xx-rollback.json"), {
    insertBefore: { "sup-1": [errTurn("e1", { hasDiagnosis: false }, "server_error"), errTurn("e2", { hasDiagnosis: false }, "rate_limit")] },
  });
  const c = createTestContainer({ fixture });
  await assert.rejects(c.incidents.open({ scenarioId: "deploy-5xx-rollback" }, { requestId: null }), (e) => e instanceof LlmUnavailableError);
  const persisted = c.incidents.list({ limit: 1 })[0]!;
  assert.deepEqual([persisted.status, persisted.escalationReason], ["escalated", "llm_unavailable"]);
  assert.equal(c.incidents.postmortem(persisted.id).status, "partial");
  assert.equal(c.store.listRuns(persisted.id)[0]!.outcome, "escalated");
});

test("open raises RunTimeoutError after persisting a timeout escalation with the last state", async () => {
  const fixture = patchFixture(readFixture("fixtures/llm/deploy-5xx-rollback.json"), { replace: { "tel-2": { delayMs: 500 } } });
  const c = createTestContainer({ fixture, runTimeoutMs: 80 });
  const t0 = Date.now();
  await assert.rejects(c.incidents.open({ scenarioId: "deploy-5xx-rollback" }, { requestId: null }), (e) => e instanceof RunTimeoutError);
  assert.ok(Date.now() - t0 < 400);
  const persisted = c.incidents.list({ limit: 1 })[0]!;
  assert.deepEqual([persisted.status, persisted.escalationReason], ["escalated", "timeout"]);
  const saved = c.store.loadBlackboard(persisted.id).blackboard;
  assert.equal(saved.supervisor.iterations, 1);
  assert.equal(saved.postmortem!.status, "partial");
});
