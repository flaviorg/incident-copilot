// Servidor MCP por stdio com cliente real (spec 5.4; AC-34 a AC-37). O incidente é criado pela API HTTP num arquivo
// de banco; o servidor MCP, outro processo, abre o mesmo arquivo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../../src/http/server.ts";
import { createTestContainer, TEST_APPROVAL_TOKEN } from "../helpers/container.ts";
import { createTestClient } from "../helpers/mcp-client.ts";
import { CHILD_NODE_ARGS, PROJECT_ROOT } from "../helpers/spawn.ts";

type Structured = Record<string, any>;

const setup = async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "ic-")), "ic.db");
  const c = createTestContainer({ dbPath });
  const created = await buildServer(c).inject({ method: "POST", url: "/incidents", payload: { scenarioId: "deploy-5xx-rollback" } });
  assert.equal(created.statusCode, 201);
  const m = await createTestClient({ dbPath });
  return { c, m, dbPath };
};

const propose = (args: Record<string, unknown>) => ({ name: "propose_remediation", arguments: { incidentId: "INC-0001", runbookRef: "orders-5xx-after-deploy#Mitigation", ...args } });
const note = (text: string) => propose({ actionType: "add_incident_note", target: "incident/INC-0001", params: { text }, rationale: "record" });

test("exposes exactly three tools", async () => {
  const { m, c } = await setup();
  try {
    const tools = (await m.client.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), ["get_incident", "list_incidents", "propose_remediation"]);
    assert.ok(tools.every((t) => (t.description ?? "").startsWith("Use to")));
    assert.ok(tools.every((t) => t.outputSchema));
    assert.equal(m.client.getServerVersion()?.name, "incident-copilot");
  } finally {
    await m.close();
    c.close();
  }
});

test("same store as the API: incident created over HTTP shows up", async () => {
  const { m, c } = await setup();
  try {
    const r = await m.client.callTool({ name: "list_incidents", arguments: {} });
    const s = r.structuredContent as Structured;
    assert.equal(s.incidents[0].id, "INC-0001");
    assert.equal(s.incidents[0].status, "awaiting_approval");
    assert.match((r.content as { text: string }[])[0]!.text, /INC-0001/);
    const filtered = (await m.client.callTool({ name: "list_incidents", arguments: { status: "resolved" } })).structuredContent as Structured;
    assert.equal(filtered.incidents.length, 0);
  } finally {
    await m.close();
    c.close();
  }
});

test("get_incident returns the view and the last N trace events in seq order", async () => {
  const { m, c } = await setup();
  try {
    const r = (await m.client.callTool({ name: "get_incident", arguments: { incidentId: "INC-0001", traceLimit: 5 } })).structuredContent as Structured;
    assert.equal(r.incident.incident.id, "INC-0001");
    assert.equal(r.trace.length, 5);
    assert.ok(r.trace[0].seq < r.trace[4].seq);
    assert.equal(r.trace[4].seq, r.incident.traceCount, "os mais recentes");
    const handoffs = (await m.client.callTool({ name: "get_incident", arguments: { incidentId: "INC-0001", traceLimit: 50, traceTypes: ["handoff"] } })).structuredContent as Structured;
    assert.ok(handoffs.trace.length > 0 && handoffs.trace.every((e: { type: string }) => e.type === "handoff"));
    const missing = await m.client.callTool({ name: "get_incident", arguments: { incidentId: "INC-9999" } });
    assert.equal(missing.isError, true);
    assert.match((missing.content as { text: string }[])[0]!.text, /incident not found/);
  } finally {
    await m.close();
    c.close();
  }
});

test("tier 2 becomes ready, tier 3 creates an approval, nothing executes", async () => {
  const { c, m } = await setup();
  try {
    const t2 = (await m.client.callTool(note("via mcp"))).structuredContent as Structured;
    assert.deepEqual([t2.tier, t2.status, t2.approvalId], [2, "ready", null]);
    assert.equal(t2.dryRun.ok, true);
    const t3 = (await m.client.callTool(propose({ actionType: "rollback_deployment", target: "deployment/orders-api", params: { toVersion: "v3.7.2" }, rationale: "second opinion" }))).structuredContent as Structured;
    assert.deepEqual([t3.tier, t3.status, t3.approvalId], [3, "awaiting_approval", "APR-0002"]);
    assert.ok(!c.store.listAudit("INC-0001").some((e) => e.event === "action_executed"));
    const external = c.store.listActions("INC-0001").filter((x) => x.proposedBy === "mcp_client");
    assert.equal(external.length, 2);
    assert.ok(external.every((a) => a.planRevision === null && a.dependsOn.length === 0));
    assert.deepEqual(external.map((a) => a.order), [4, 5]);
    const bb = c.store.loadBlackboard("INC-0001").blackboard;
    assert.deepEqual(bb.actions.filter((a) => a.proposedBy === "mcp_client").map((a) => a.status), ["ready", "awaiting_approval"]);
    assert.equal(c.store.getApproval("APR-0002")!.status, "pending");
    const audited = c.store.listAudit("INC-0001").filter((e) => e.actor.startsWith("mcp_client:"));
    assert.deepEqual(audited.map((e) => e.event), ["action_ready", "approval_requested"]);
    assert.equal(audited[0]!.actor, "mcp_client:incident-copilot-tests");
    assert.ok(c.store.listTrace("INC-0001").some((e) => e.agent === "mcp_client"));
    assert.equal(c.incidents.get("INC-0001").incident.status, "awaiting_approval");
  } finally {
    await m.close();
    c.close();
  }
});

test("forbidden and unknown types are short isError results and are audited", async () => {
  const { c, m } = await setup();
  try {
    const r = await m.client.callTool(propose({ actionType: "delete_backups", target: "backup_vault/orders-api/prod", params: {}, rationale: "x" }));
    assert.equal(r.isError, true);
    const text = (r.content as { text: string }[])[0]!.text;
    assert.ok(text.length < 200, text);
    assert.doesNotMatch(text, /SQL|at \w+ \(|node_modules/);
    assert.ok(c.store.listAudit("INC-0001").some((e) => e.event === "action_blocked_forbidden" && e.actor.startsWith("mcp_client:")));
    const unknown = await m.client.callTool(propose({ actionType: "capture_heap_dump", target: "deployment/orders-api", params: {}, rationale: "x" }));
    assert.equal(unknown.isError, true);
    assert.ok(c.store.listAudit("INC-0001").some((e) => e.event === "action_blocked_unknown" && e.actor.startsWith("mcp_client:")));
    const statuses = c.store.listActions("INC-0001").filter((a) => a.proposedBy === "mcp_client").map((a) => [a.actionType, a.status, a.tier]);
    assert.deepEqual(statuses, [["delete_backups", "blocked_forbidden", 4], ["capture_heap_dump", "blocked_unknown", 4]]);
    const badParams = await m.client.callTool(propose({ actionType: "rollback_deployment", target: "deployment/orders-api", params: { version: "v3.7.2" }, rationale: "x" }));
    assert.equal(badParams.isError, true);
    assert.match((badParams.content as { text: string }[])[0]!.text, /invalid parameters/);
    const invalid = await m.client.callTool({ name: "propose_remediation", arguments: { incidentId: "INC-0001" } });
    assert.equal(invalid.isError, true);
  } finally {
    await m.close();
    c.close();
  }
});

test("oversized fields are refused before anything is stored or traced", async () => {
  // Revisão final: um alvo de 50 mil caracteres virava faixa 3 com aprovação pendente e entrava inteiro no trace.
  const { c, m } = await setup();
  try {
    const traceBefore = c.store.listTrace("INC-0001").length;
    const cases = [
      ["target", propose({ actionType: "add_incident_note", target: "incident/" + "y".repeat(50_000), params: { text: "hi" }, rationale: "r" })],
      ["params", propose({ actionType: "capture_heap_dump", target: "deployment/orders-api", params: { dump: "z".repeat(50_000) }, rationale: "r" })],
    ] as const;
    for (const [field, call] of cases) {
      const r = await m.client.callTool(call);
      assert.equal(r.isError, true, field);
      const text = (r.content as { text: string }[])[0]!.text;
      assert.match(text, new RegExp(field));
      assert.ok(text.length < 400, text);
    }
    assert.ok(!c.store.listActions("INC-0001").some((a) => a.proposedBy === "mcp_client"));
    assert.deepEqual(c.store.listApprovals({ incidentId: "INC-0001" }).map((a) => a.id), ["APR-0001"]);
    assert.equal(c.store.listTrace("INC-0001").length, traceBefore);
  } finally {
    await m.close();
    c.close();
  }
});

test("incidents not awaiting approval reject proposals", async () => {
  const { c, m } = await setup();
  try {
    const decided = await c.approvals.decide("APR-0001", { decision: "approve", approver: "ana" }, TEST_APPROVAL_TOKEN, { requestId: null });
    assert.equal(decided.incident.incident.status, "resolved");
    const r = await m.client.callTool(note("too late"));
    assert.equal(r.isError, true);
    assert.match((r.content as { text: string }[])[0]!.text, /does not accept proposals/);
    assert.ok(!c.store.listActions("INC-0001").some((a) => a.proposedBy === "mcp_client"));
  } finally {
    await m.close();
    c.close();
  }
});

test("MCP proposals run together with the batch on the human decision", async () => {
  const { c, m } = await setup();
  try {
    const t2 = (await m.client.callTool(note("via mcp, runs with the batch"))).structuredContent as Structured;
    assert.equal(t2.status, "ready");
    const decided = await c.approvals.decide("APR-0001", { decision: "approve", approver: "ana" }, TEST_APPROVAL_TOKEN, { requestId: null });
    assert.equal(decided.incident.incident.status, "resolved");
    const mcpNote = decided.incident.actions.find((a) => a.id === t2.actionId)!;
    assert.equal(mcpNote.status, "succeeded");
    assert.ok(c.store.listAudit("INC-0001").some((e) => e.event === "action_executed" && e.details.actionId === t2.actionId));
  } finally {
    await m.close();
    c.close();
  }
});

test("stdout carries only JSON-RPC; logs go to stderr", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "ic-")), "ic.db");
  const child = spawn(process.execPath, [...CHILD_NODE_ARGS, "src/mcp/server.ts"], {
    cwd: PROJECT_ROOT,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DB_PATH: dbPath, LLM_PROVIDER: "fake", CLOCK: "simulated" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } }) + "\n");
    const deadline = Date.now() + 8000;
    while (!(stdout.includes('"id":1') && stderr.includes("mcp ready")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    const lines = stdout.split("\n").filter((l) => l.trim() !== "");
    assert.ok(lines.length >= 1, "response to initialize");
    for (const l of lines) assert.equal(JSON.parse(l).jsonrpc, "2.0");
    assert.equal(JSON.parse(lines[0]!).result.serverInfo.name, "incident-copilot");
    const logs = stderr.split("\n").filter((l) => l.startsWith("{"));
    assert.ok(logs.length >= 1, "at least one JSON log line on stderr");
    for (const l of logs) assert.ok(JSON.parse(l).level);
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
  }
});
