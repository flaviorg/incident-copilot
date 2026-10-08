// API HTTP via app.inject, sem abrir porta (spec 4.4, 5.3 e 6.9; AC-01, AC-16, AC-18, AC-30, AC-32, AC-33).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../../src/http/server.ts";
import { requestIdFrom } from "../../src/http/request-id.ts";
import { createTestContainer, TEST_APPROVAL_TOKEN } from "../helpers/container.ts";
import { errTurn, patchFixture, readFixture } from "../helpers/fixtures.ts";
import { sha256Hex } from "../../src/infra/crypto.ts";
import { canonicalJson } from "../../src/domain/canonical-json.ts";

const app = () => buildServer(createTestContainer());
const TOKEN = TEST_APPROVAL_TOKEN;
type App = ReturnType<typeof buildServer>;
const post = (a: App, url: string, payload: unknown, headers: Record<string, string> = {}) => a.inject({ method: "POST", url, payload: payload as object, headers });
const get = (a: App, url: string, headers: Record<string, string> = {}) => a.inject({ method: "GET", url, headers });

test("health reports the provider and sets a generated request id", async () => {
  const r = await app().inject({ method: "GET", url: "/health" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().provider, "fake");
  assert.equal(r.json().status, "ok");
  assert.match(r.json().version, /^\d+\.\d+\.\d+$/);
  assert.match(r.headers["x-request-id"] as string, /^[0-9a-f-]{36}$/);
});

test("valid incoming request id is reused; invalid is replaced", async () => {
  assert.equal((await app().inject({ method: "GET", url: "/health", headers: { "x-request-id": "abc-123" } })).headers["x-request-id"], "abc-123");
  assert.notEqual((await app().inject({ method: "GET", url: "/health", headers: { "x-request-id": "a b<script>" } })).headers["x-request-id"], "a b<script>");
  assert.match(requestIdFrom("x".repeat(65)), /^[0-9a-f-]{36}$/);
  assert.match(requestIdFrom(["a", "b"]), /^[0-9a-f-]{36}$/);
  assert.equal(requestIdFrom("req.1_A-b"), "req.1_A-b");
});

test("scenarios lists both", async () => {
  const r = await app().inject({ method: "GET", url: "/scenarios" });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().map((s: { id: string }) => s.id).sort(), ["cost-anomaly", "deploy-5xx-rollback"]);
});

test("unknown route uses the error envelope without stack", async () => {
  const r = await app().inject({ method: "GET", url: "/nope" });
  const b = r.json();
  assert.equal(r.statusCode, 404);
  assert.ok(b.error.code && b.error.message && b.error.requestId);
  assert.equal(b.error.requestId, r.headers["x-request-id"]);
  assert.ok(!JSON.stringify(b).includes("stack"));
});

// ---------- Tarefa 33: incidentes e aprovações ----------

test("POST /incidents creates and stops awaiting approval", async () => {
  const r = await post(app(), "/incidents", { scenarioId: "deploy-5xx-rollback" });
  assert.equal(r.statusCode, 201);
  assert.equal(r.json().incident.status, "awaiting_approval");
  assert.equal(r.json().approvals[0].id, "APR-0001");
  assert.equal(r.json().postmortemReady, false);
});

test("400 with issues, 404 for unknown scenario", async () => {
  const a = app();
  const bad = await post(a, "/incidents", {});
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, "validation_error");
  assert.ok(bad.json().error.issues.length > 0);
  assert.equal(bad.json().error.issues[0].path, "scenarioId");
  assert.equal((await post(a, "/incidents", { scenarioId: "deploy-5xx-rollback", title: "x".repeat(121) })).statusCode, 400);
  const nf = await post(a, "/incidents", { scenarioId: "nope" });
  assert.equal(nf.statusCode, 404);
  assert.equal(nf.json().error.code, "scenario_not_found");
  // Revisão final: um id de 60 KB voltava inteiro na mensagem do 404.
  const huge = await post(a, "/incidents", { scenarioId: "x".repeat(60_000) });
  assert.deepEqual([huge.statusCode, huge.json().error.code, huge.json().error.issues[0].path], [400, "validation_error", "scenarioId"]);
  assert.ok(huge.body.length < 1_000, String(huge.body.length));
  const notJson = await a.inject({ method: "POST", url: "/incidents", payload: "{nope", headers: { "content-type": "application/json" } });
  assert.deepEqual([notJson.statusCode, notJson.json().error.code], [400, "invalid_json"]);
});

test("list, view, trace, audit and postmortem readiness", async () => {
  const a = app();
  await post(a, "/incidents", { scenarioId: "deploy-5xx-rollback" });
  const list = await get(a, "/incidents?status=awaiting_approval");
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().map((i: { id: string }) => i.id), ["INC-0001"]);
  assert.equal((await get(a, "/incidents?status=resolved")).json().length, 0);
  assert.equal((await get(a, "/incidents?limit=0")).statusCode, 400);
  assert.equal((await get(a, "/incidents?limit=51")).statusCode, 400);
  assert.equal((await get(a, "/incidents?status=bogus")).statusCode, 400);
  const view = await get(a, "/incidents/INC-0001");
  assert.equal(view.statusCode, 200);
  assert.equal(view.json().incident.id, "INC-0001");
  assert.equal(view.json().traceCount > 0, true);
  const missing = await get(a, "/incidents/INC-9999");
  assert.deepEqual([missing.statusCode, missing.json().error.code], [404, "not_found"]);

  const handoffs = (await get(a, "/incidents/INC-0001/trace?type=handoff")).json() as { type: string; seq: number }[];
  assert.ok(handoffs.length > 0);
  assert.ok(handoffs.every((e) => e.type === "handoff"));
  assert.deepEqual(handoffs.map((e) => e.seq), [...handoffs.map((e) => e.seq)].sort((x, y) => x - y));
  assert.equal((await get(a, "/incidents/INC-0001/trace?limit=3")).json().length, 3);
  assert.equal((await get(a, "/incidents/INC-0001/trace?limit=0")).statusCode, 400);
  assert.equal((await get(a, "/incidents/INC-0001/trace?limit=501")).statusCode, 400);
  assert.equal((await get(a, "/incidents/INC-0001/trace?agent=nobody")).statusCode, 400);
  assert.equal((await get(a, "/incidents/INC-9999/trace")).statusCode, 404);

  const audit = await get(a, "/incidents/INC-0001/audit");
  assert.equal(audit.statusCode, 200);
  assert.ok(audit.json().length > 0);
  assert.ok(audit.json().every((e: { hash: string }) => /^[0-9a-f]{64}$/.test(e.hash)));
  assert.equal((await get(a, "/incidents/INC-9999/audit")).statusCode, 404);

  const pm = await get(a, "/incidents/INC-0001/postmortem");
  assert.deepEqual([pm.statusCode, pm.json().error.code], [409, "postmortem_not_ready"]);
  assert.equal((await get(a, "/incidents/INC-9999/postmortem")).statusCode, 404);
  assert.equal((await get(a, "/incidents/INC-0001/postmortem?format=xml")).statusCode, 400);

  // Segundo incidente do mesmo cenário no mesmo processo, com X-Request-Id próprio.
  const second = await post(a, "/incidents", { scenarioId: "deploy-5xx-rollback" }, { "x-request-id": "req-1" });
  assert.equal(second.statusCode, 201);
  assert.equal(second.headers["x-request-id"], "req-1");
  const id = second.json().incident.id;
  assert.equal(id, "INC-0002");
  const opened = (await get(a, `/incidents/${id}/audit`)).json().find((e: { event: string }) => e.event === "incident_opened");
  assert.equal(opened.details.requestId, "req-1");
  const trace = (await get(a, `/incidents/${id}/trace`)).json() as { requestId: string | null }[];
  assert.ok(trace.length > 0);
  assert.ok(trace.every((e) => e.requestId === "req-1"));
});

test("decision codes: 401, 422, 400, 200, 409", async () => {
  const a = app();
  await post(a, "/incidents", { scenarioId: "deploy-5xx-rollback" });
  assert.deepEqual((await get(a, "/approvals")).json().map((x: { id: string }) => x.id), ["APR-0001"]);
  assert.equal((await post(a, "/approvals/APR-0001/decision", { decision: "approve", approver: "ana" })).statusCode, 401);
  const wrong = await post(a, "/approvals/APR-0001/decision", { decision: "approve", approver: "ana" }, { "x-approval-token": "errado-errado-errado" });
  assert.deepEqual([wrong.statusCode, wrong.json().error.code, wrong.json().error.message], [401, "invalid_token", "token de aprovação inválido ou ausente"]);
  const ambiguous = await post(a, "/approvals/APR-0001/decision", { text: "sim, mas espera", approver: "ana" }, { "x-approval-token": TOKEN });
  assert.deepEqual([ambiguous.statusCode, ambiguous.json().error.code], [422, "ambiguous_decision"]);
  const both = await post(a, "/approvals/APR-0001/decision", { decision: "approve", text: "sim", approver: "ana" }, { "x-approval-token": TOKEN });
  assert.deepEqual([both.statusCode, both.json().error.code], [400, "validation_error"]);
  assert.equal((await post(a, "/approvals/APR-9999/decision", { decision: "approve", approver: "ana" }, { "x-approval-token": TOKEN })).statusCode, 404);
  const ok = await post(a, "/approvals/APR-0001/decision", { decision: "approve", approver: "ana" }, { "x-approval-token": TOKEN, "x-request-id": "req-decide" });
  assert.deepEqual([ok.statusCode, ok.json().incident.incident.status, ok.json().approval.status], [200, "resolved", "approved"]);
  const again = await post(a, "/approvals/APR-0001/decision", { decision: "approve", approver: "ana" }, { "x-approval-token": TOKEN });
  assert.deepEqual([again.statusCode, again.json().error.code], [409, "approval_not_pending"]);
  const approvedAudit = (await get(a, "/incidents/INC-0001/audit")).json().find((e: { event: string }) => e.event === "approval_approved");
  assert.equal(approvedAudit.details.requestId, "req-decide");
  assert.deepEqual((await get(a, "/approvals?status=approved")).json().map((x: { id: string }) => x.id), ["APR-0001"]);
  assert.equal((await get(a, "/approvals")).json().length, 0);
  assert.equal((await get(a, "/approvals?status=bogus")).statusCode, 400);

  const md = await get(a, "/incidents/INC-0001/postmortem");
  assert.equal(md.statusCode, 200);
  assert.match(md.headers["content-type"] as string, /^text\/markdown; charset=utf-8/);
  assert.match(md.body, /INC-0001/);
  const json = await get(a, "/incidents/INC-0001/postmortem?format=json");
  assert.deepEqual([json.statusCode, json.json().status, json.json().incidentId], [200, "final", "INC-0001"]);
});

test("429 after five wrong tokens, 503 without APPROVAL_TOKEN, 409 approval_expired", async () => {
  const a = app();
  await post(a, "/incidents", { scenarioId: "deploy-5xx-rollback" });
  for (let i = 0; i < 5; i++) {
    assert.equal((await post(a, "/approvals/APR-0001/decision", { decision: "approve", approver: "ana" }, { "x-approval-token": `errado-${i}-0123456789` })).statusCode, 401);
  }
  const locked = await post(a, "/approvals/APR-0001/decision", { decision: "approve", approver: "ana" }, { "x-approval-token": TOKEN });
  assert.deepEqual([locked.statusCode, locked.json().error.code], [429, "approvals_locked"]);

  const noToken = buildServer(createTestContainer({ approvalToken: null }));
  await post(noToken, "/incidents", { scenarioId: "deploy-5xx-rollback" });
  const disabled = await post(noToken, "/approvals/APR-0001/decision", { decision: "approve", approver: "ana" }, { "x-approval-token": TOKEN });
  assert.deepEqual([disabled.statusCode, disabled.json().error.code], [503, "approvals_disabled"]);

  const c = createTestContainer();
  const b = buildServer(c);
  await post(b, "/incidents", { scenarioId: "deploy-5xx-rollback" });
  c.clock.tick(31 * 60);
  // Leitura projeta a expiração sem gravar nada.
  assert.deepEqual((await get(b, "/approvals?status=expired")).json().map((x: { id: string }) => x.id), ["APR-0001"]);
  assert.equal((await get(b, "/incidents/INC-0001")).json().approvals[0].status, "expired");
  assert.equal(c.store.getApproval("APR-0001")!.status, "pending");
  const expired = await post(b, "/approvals/APR-0001/decision", { decision: "approve", approver: "ana" }, { "x-approval-token": TOKEN });
  assert.deepEqual([expired.statusCode, expired.json().error.code], [409, "approval_expired"]);
  assert.equal(c.store.getApproval("APR-0001")!.status, "expired");
  const after = (await get(b, "/incidents/INC-0001")).json();
  assert.deepEqual([after.incident.status, after.incident.escalation.reason], ["escalated", "mitigation_rejected"]);
});

test("413 for bodies over 64 KB", async () => {
  const r = await post(app(), "/incidents", { scenarioId: "x".repeat(70_000) });
  assert.deepEqual([r.statusCode, r.json().error.code], [413, "payload_too_large"]);
  assert.ok(r.headers["x-request-id"]);
});

test("decision stays 200 when the resume escalates because the LLM is down", async () => {
  const fx = patchFixture(readFixture("fixtures/llm/deploy-5xx-rollback.json"), {
    insertBefore: { "sup-5": [errTurn("e1", { verified: true }, "server_error"), errTurn("e2", { verified: true }, "server_error")] },
  });
  const a = buildServer(createTestContainer({ fixture: fx }));
  await post(a, "/incidents", { scenarioId: "deploy-5xx-rollback" });
  const r = await post(a, "/approvals/APR-0001/decision", { decision: "approve", approver: "ana" }, { "x-approval-token": TOKEN });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().incident.incident.status, "escalated");
  assert.equal(r.json().incident.incident.escalation.reason, "llm_unavailable");
});

// ---------- Tarefa 34: /stats ----------

test("GET /stats after an approved, a rejected and an expired run", async () => {
  // Fixture do deploy com o sup-1 da guard-coercion (pede o portão sem plano): a guarda coage em todo incidente.
  const coerced = readFixture("tests/fixtures/llm/guard-coercion.json").turns.find((t) => t.id === "sup-1")!;
  const fx = patchFixture(readFixture("fixtures/llm/deploy-5xx-rollback.json"), { replace: { "sup-1": { output: coerced.output } } });
  const c = createTestContainer({ fixture: fx });
  const a = buildServer(c);
  const decide = (id: string, decision: "approve" | "reject") => post(a, `/approvals/${id}/decision`, { decision, approver: "ana" }, { "x-approval-token": TOKEN });

  await post(a, "/incidents", { scenarioId: "deploy-5xx-rollback" });
  assert.equal((await decide("APR-0001", "approve")).json().incident.incident.status, "resolved");
  await post(a, "/incidents", { scenarioId: "deploy-5xx-rollback" });
  assert.equal((await decide("APR-0002", "reject")).json().incident.incident.status, "escalated");
  await post(a, "/incidents", { scenarioId: "deploy-5xx-rollback" });
  c.clock.tick(31 * 60);

  const r = await get(a, "/stats?since=24h");
  assert.equal(r.statusCode, 200);
  const s = r.json();
  assert.equal(s.window, "24h");
  assert.equal(s.incidents.total, 3);
  assert.deepEqual([s.incidents.byStatus.resolved, s.incidents.byStatus.escalated, s.incidents.byStatus.awaiting_approval], [1, 1, 1]);
  const resolvedMttr = c.incidents.list({ status: "resolved", limit: 1 })[0]!.mttrMin;
  assert.deepEqual(s.mttrMin, { p50: resolvedMttr, p95: resolvedMttr });
  assert.ok(s.actions.byTier["2"] >= 2);
  assert.equal(s.actions.byTier["3"], 3);
  assert.deepEqual(s.approvals, { pending: 0, approved: 1, rejected: 1, expired: 1 });
  assert.equal(c.store.getApproval("APR-0003")!.status, "pending");
  assert.ok(s.guard.supervisorCoercions >= 3);
  assert.ok(s.llm.calls > 0);
  assert.equal(s.llm.estimatedCostUsd, 0);
  assert.equal((await get(a, "/stats")).json().window, "24h");
  assert.equal((await get(a, "/stats?since=7d")).json().incidents.total, 3);
  const bad = await get(a, "/stats?since=1y");
  assert.deepEqual([bad.statusCode, bad.json().error.code], [400, "validation_error"]);
});

test("the audit trail returned by the API can be verified by the client (prevHash and hash)", async () => {
  const a = app();
  // Dois incidentes intercalados no mesmo banco: cada trilha é uma cadeia própria, desde o gênese.
  await post(a, "/incidents", { scenarioId: "deploy-5xx-rollback" });
  await post(a, "/incidents", { scenarioId: "deploy-5xx-rollback" });
  await post(a, "/approvals/APR-0001/decision", { decision: "approve", approver: "ana" }, { "x-approval-token": TOKEN });
  for (const incidentId of ["INC-0001", "INC-0002"]) {
    const rows = (await get(a, `/incidents/${incidentId}/audit`)).json() as { id: string; ts: string; actor: string; event: string; tier: number | null; details: Record<string, unknown>; prevHash: string; hash: string }[];
    assert.ok(rows.length >= 4);
    assert.equal(rows[0]!.prevHash, "0".repeat(64));
    for (const [i, r] of rows.entries()) {
      // incidentId vem da URL; o resto do corpo do hash vem da própria resposta.
      const body = { id: r.id, ts: r.ts, incidentId, actor: r.actor, event: r.event, tier: r.tier, details: r.details };
      assert.equal(r.hash, sha256Hex(r.prevHash + "\n" + canonicalJson(body)), r.id);
      if (i > 0) assert.equal(r.prevHash, rows[i - 1]!.hash, `${r.id} encadeia na linha anterior do mesmo incidente`);
    }
  }
});
