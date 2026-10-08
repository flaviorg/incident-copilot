// Nenhum segredo nas 7 superfícies de saída (spec 6.6; AC-17): HTTP, MCP, trace, auditoria, logs, relatórios e gravações.
// O token também é colado no comentário da decisão e a chave do OpenRouter é usada como token errado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../../src/http/server.ts";
import { recordScenarioWithTokens } from "../../src/app/demo-recorder.ts";
import { createTestContainer } from "../helpers/container.ts";
import { createTestClient } from "../helpers/mcp-client.ts";
import { findSecretOccurrences } from "../helpers/secret-scan.ts";

const TOKEN = "TOKEN-e2e-0123456789abcdef";
const KEY = "sk-or-v1-" + "b".repeat(40);

test("findSecretOccurrences reports surface and a masked secret", () => {
  assert.deepEqual(findSecretOccurrences([{ name: "a", text: `x ${TOKEN} y` }, { name: "b", text: "limpo" }], [TOKEN, KEY]), [{ surface: "a", secret: "TOKE…(26 caracteres)" }]);
});

test("no secret value appears in any output surface", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "ic-")), "ic.db");
  const c = createTestContainer({ dbPath, approvalToken: TOKEN, env: { OPENROUTER_API_KEY: KEY } }); // provedor continua fake (LLM_PROVIDER=fake)
  assert.equal(c.config.llmProvider, "fake");
  assert.deepEqual([...c.secrets].sort(), [KEY, TOKEN].sort());
  const app = buildServer(c);
  const http: string[] = [];
  const keep = <R extends { headers: Record<string, unknown>; body: string }>(r: R) => {
    http.push(JSON.stringify(r.headers) + r.body);
    return r;
  };
  keep(await app.inject({ method: "POST", url: "/incidents", payload: { scenarioId: "deploy-5xx-rollback" } }));
  const wrong = keep(await app.inject({ method: "POST", url: "/approvals/APR-0001/decision", payload: { decision: "approve", approver: "ana" }, headers: { "x-approval-token": KEY } }));
  assert.equal(wrong.statusCode, 401);
  const ok = keep(await app.inject({
    method: "POST", url: "/approvals/APR-0001/decision",
    payload: { decision: "approve", approver: "ana", comment: `token ${TOKEN} e chave ${KEY}` }, headers: { "x-approval-token": TOKEN },
  }));
  assert.equal(ok.statusCode, 200);
  assert.match(ok.json().approval.comment, /\[REDACTED\]/);
  for (const u of ["/incidents/INC-0001", "/incidents/INC-0001/trace", "/incidents/INC-0001/audit", "/approvals?status=approved", "/stats"]) keep(await app.inject({ method: "GET", url: u }));
  const report = keep(await app.inject({ method: "GET", url: "/incidents/INC-0001/postmortem" })).body;

  const m = await createTestClient({ dbPath, env: { APPROVAL_TOKEN: TOKEN, OPENROUTER_API_KEY: KEY } });
  const mcp = [
    await m.client.callTool({ name: "list_incidents", arguments: {} }),
    await m.client.callTool({ name: "get_incident", arguments: { incidentId: "INC-0001", traceLimit: 50 } }),
  ].map((x) => JSON.stringify(x));
  await m.close();

  // O gravador cria containers próprios, com token aleatório e sem herdar process.env. Para a 7ª superfície não passar
  // por construção: a chave fica em process.env durante a gravação e os tokens efetivamente usados nas decisões entram
  // na varredura.
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = KEY;
  let recorded: Awaited<ReturnType<typeof recordScenarioWithTokens>>;
  try {
    recorded = await recordScenarioWithTokens("deploy-5xx-rollback");
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
  assert.equal(recorded.approvalTokens.length, 2, "um token por ramo (aprovar e rejeitar)");
  assert.ok(recorded.approvalTokens.every((t) => t.length >= 16));
  assert.equal(recorded.recording.branches?.approved.approvals[0]?.status, "approved", "as decisões usaram o token do gravador");

  const surfaces = [
    { name: "http", text: http.join("\n") },
    { name: "mcp", text: mcp.join("\n") + m.stderr.join("\n") },
    { name: "trace", text: JSON.stringify(c.store.listTrace("INC-0001")) },
    { name: "audit", text: JSON.stringify(c.store.listAudit("INC-0001")) },
    { name: "logs", text: c.logs.join("\n") },
    { name: "reports", text: report },
    { name: "recordings", text: JSON.stringify(recorded.recording) },
  ];
  assert.equal(surfaces.length, 7);
  for (const s of surfaces) assert.ok(s.text.length > 0, s.name);
  assert.ok(m.stderr.length > 0, "o servidor MCP escreveu logs em stderr");
  assert.deepEqual(findSecretOccurrences(surfaces, [TOKEN, KEY, ...recorded.approvalTokens]), []);
  c.close();
});
