import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  TierSchema,
  RemediationPlanSchema,
  TraceEventSchema,
  DecisionBodySchema,
  GatedActionSchema,
  DemoRecordingSchema,
  EscalationReasonSchema,
  PlanStepSchema,
  ProposeRemediationInputSchema,
} from "../../src/contracts/index.ts";
import { TRACE_ARG_MAX_CHARS } from "../../src/app/trace-sink.ts";
import { openIncidentRecord } from "../../src/app/incident-setup.ts";
import { createTestContainer } from "../helpers/container.ts";
import { FixtureFileSchema } from "../../src/llm/fixture-format.ts";
import { promptHash } from "../../src/llm/prompt-hash.ts";
import type { PromptDef } from "../../src/llm/provider.ts";
import { ALL_PROMPTS } from "../../src/prompts/v1/index.ts";
import { fixtureFiles } from "../../scripts/rehash-fixtures.ts";

const step = (order: number) => ({
  order,
  actionType: "add_incident_note",
  target: "incident/INC-0001",
  params: { text: "note" },
  rationale: "registrar contexto",
  runbookRef: null,
  dependsOn: [],
});

const handoffEvent = () => ({
  id: "INC-0001:1",
  incidentId: "INC-0001",
  runId: "RUN-0001",
  requestId: null,
  seq: 1,
  ts: "2026-10-04T09:42:30.000Z",
  agent: "supervisor",
  llm: null,
  type: "handoff",
  payload: { from: "supervisor", to: "telemetry_analyst", brief: "investigate", reason: "no diagnosis" },
});

const action = () => ({
  id: "ACT-0001",
  incidentId: "INC-0001",
  planRevision: 0,
  order: 1,
  actionType: "rollback_deployment",
  target: "deployment/orders-api",
  params: { toVersion: "v3.7.2" },
  dependsOn: [],
  tier: 3,
  classificationReasons: ["catalog tier: 3"],
  status: "awaiting_approval",
  dryRun: null,
  approvalId: "APR-0001",
  proposedBy: "remediation_planner",
  executedAt: null,
  resultSummary: null,
});

/** Lista recursiva de arquivos .ts; devolve [] se a pasta não existir. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("tiers are 1 to 4", () => { assert.equal(TierSchema.safeParse(5).success, false); assert.equal(TierSchema.safeParse(4).success, true); });
test("plan has at most 8 steps", () => assert.equal(RemediationPlanSchema.safeParse({ summary: "s", steps: Array.from({ length: 9 }, (_, i) => step(i + 1)) }).success, false));
test("trace is a discriminated union", () => {
  assert.equal(TraceEventSchema.safeParse(handoffEvent()).success, true);
  assert.equal(TraceEventSchema.safeParse({ ...handoffEvent(), type: "unknown" }).success, false);
});
test("decision body requires exactly one of decision and text", () => {
  assert.equal(DecisionBodySchema.safeParse({ approver: "ana" }).success, false);
  assert.equal(DecisionBodySchema.safeParse({ decision: "approve", text: "sim", approver: "ana" }).success, false);
  assert.equal(DecisionBodySchema.safeParse({ text: "sim", approver: "ana" }).success, true);
  assert.equal(DecisionBodySchema.safeParse({ decision: "approve", approver: "" }).success, false);
});
test("MCP actions have null planRevision", () => assert.equal(GatedActionSchema.safeParse({ ...action(), planRevision: null, proposedBy: "mcp_client" }).success, true));
test("demo label is a literal", () => assert.equal(DemoRecordingSchema.shape.label.safeParse("outra coisa").success, false));
test("escalation reasons include low_confidence_diagnosis", () => assert.ok(EscalationReasonSchema.options.includes("low_confidence_diagnosis")));
test("contracts and domain import neither node: nor outer layers", () => {
  for (const file of walk("src/contracts").concat(walk("src/domain"))) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /from\s+["']node:/, file);
    assert.doesNotMatch(text, /from\s+["'](\.\.\/)+(infra|llm|graph|app|http|mcp|cli)\//, file);
  }
});

// Spec 7.2, regra 4, e 8.2: fixture inválida falha aqui, não no meio da demo.
function fixtureProblems(raw: unknown, prompts: PromptDef<any, any>[]): string[] {
  const parsed = FixtureFileSchema.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((i) => `formato: ${i.path.join(".")}`);
  const byVersion = new Map(prompts.map((p) => [p.version, p]));
  const problems: string[] = [];
  for (const [version, hash] of Object.entries(parsed.data.promptHashes)) {
    const p = byVersion.get(version);
    if (!p) problems.push(`unknown prompt hash: ${version}`);
    else if (hash !== promptHash(p)) problems.push(`stale hash: ${version} (run npm run fixtures:rehash)`);
  }
  for (const t of parsed.data.turns) {
    const p = byVersion.get(t.prompt);
    if (!p) { problems.push(`${t.id}: prompt desconhecido ${t.prompt}`); continue; }
    if (!(t.prompt in parsed.data.promptHashes)) problems.push(`${t.id}: prompt ${t.prompt} has no registered hash`);
    if (t.output !== undefined && !p.outputSchema.safeParse(t.output).success) problems.push(`${t.id}: output outside the schema of ${t.prompt}`);
  }
  return problems;
}

test("every LLM fixture parses, has current prompt hashes and outputs that pass each prompt schema", () => {
  const files = fixtureFiles();
  assert.ok(files.length >= 5, `expected at least 5 fixtures, found ${files.length}`);
  for (const file of files) assert.deepEqual(fixtureProblems(JSON.parse(readFileSync(file, "utf8")), ALL_PROMPTS), [], file);
  // O próprio verificador pega uma saída inválida e um hash velho.
  const broken = JSON.parse(readFileSync(files[0]!, "utf8"));
  broken.turns[0].output = { next: "escalation" };
  broken.promptHashes["planner.v1"] = "sha256:old";
  const found = fixtureProblems(broken, ALL_PROMPTS);
  assert.ok(found.some((p) => p.includes("output outside the schema")) && found.some((p) => p.includes("stale hash")), found.join("; "));
});

// Revisão final: os campos livres que chegam pelo MCP (sem autenticação) e pelo planejador têm teto de tamanho.
test("MCP proposal input caps every free-text field", () => {
  const base = { incidentId: "INC-0001", actionType: "add_incident_note", target: "incident/INC-0001", params: { text: "oi" }, rationale: "r", runbookRef: "rb#s" };
  assert.equal(ProposeRemediationInputSchema.safeParse(base).success, true);
  const at = { incidentId: "I".repeat(64), actionType: "a".repeat(64), target: "t".repeat(200), runbookRef: "r".repeat(120), params: { text: "x".repeat(500) } };
  assert.equal(ProposeRemediationInputSchema.safeParse({ ...base, ...at }).success, true);
  const over: [string, unknown][] = [
    ["incidentId", "I".repeat(65)],
    ["actionType", "a".repeat(65)],
    ["target", "incident/" + "y".repeat(50_000)],
    ["runbookRef", "r".repeat(121)],
    ["params", { text: "z".repeat(5_000) }],
  ];
  for (const [field, value] of over) {
    const r = ProposeRemediationInputSchema.safeParse({ ...base, [field]: value });
    assert.equal(r.success, false, field);
    assert.deepEqual(r.error!.issues.map((i) => i.path[0]), [field]);
  }
});

test("plan steps cap actionType and target", () => {
  assert.equal(PlanStepSchema.safeParse({ ...step(1), actionType: "a".repeat(64), target: "t".repeat(200) }).success, true);
  assert.equal(PlanStepSchema.safeParse({ ...step(1), actionType: "a".repeat(65) }).success, false);
  assert.equal(PlanStepSchema.safeParse({ ...step(1), target: "t".repeat(201) }).success, false);
});

test("trace sink clips long strings inside action args", () => {
  const c = createTestContainer();
  try {
    const { incident } = openIncidentRecord(
      { store: c.store, scenarios: c.scenarios, clock: c.clock, ids: c.ids, initialWorld: (s) => c.infra.initialWorld(s) },
      { scenarioId: "deploy-5xx-rollback" },
      { requestId: null },
    );
    const ctx = { incidentId: incident.id, runId: "RUN-0001", scenarioId: "deploy-5xx-rollback", requestId: null, signal: new AbortController().signal };
    const ev = c.trace.emit(ctx, "mcp_client", {
      type: "action",
      payload: { tool: "x", args: { target: "y".repeat(50_000), nested: { list: ["w".repeat(9_000), 7] }, short: "ok" }, tier: 3 },
    });
    assert.equal(ev.type, "action");
    const args = (ev.payload as { args: Record<string, any> }).args;
    assert.equal(args.target.length, TRACE_ARG_MAX_CHARS);
    assert.ok(args.target.endsWith("…"));
    assert.equal(args.nested.list[0].length, TRACE_ARG_MAX_CHARS);
    assert.deepEqual([args.nested.list[1], args.short], [7, "ok"]);
    assert.ok(JSON.stringify(c.store.listTrace(incident.id)).length < 5_000);
  } finally {
    c.close();
  }
});
