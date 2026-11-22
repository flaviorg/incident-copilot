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
import { ALL_PROMPTS, FIX_PROMPTS } from "../../src/prompts/v1/index.ts";
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

/** Recursive list of .ts files; returns [] if the folder does not exist. */
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

// Spec 7.2, rule 4, and 8.2: an invalid fixture fails here, not in the middle of the demo.
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
    if (!p) { problems.push(`${t.id}: unknown prompt ${t.prompt}`); continue; }
    if (!(t.prompt in parsed.data.promptHashes)) problems.push(`${t.id}: prompt ${t.prompt} has no registered hash`);
    if (t.output !== undefined && !p.outputSchema.safeParse(t.output).success) problems.push(`${t.id}: output outside the schema of ${t.prompt}`);
  }
  return problems;
}

test("every LLM fixture parses, has current prompt hashes and outputs that pass each prompt schema", () => {
  const files = fixtureFiles();
  assert.ok(files.length >= 5, `expected at least 5 fixtures, found ${files.length}`);
  for (const file of files) assert.deepEqual(fixtureProblems(JSON.parse(readFileSync(file, "utf8")), [...ALL_PROMPTS, ...FIX_PROMPTS]), [], file);
  // The verifier itself catches an invalid output and a stale hash.
  const broken = JSON.parse(readFileSync(files[0]!, "utf8"));
  broken.turns[0].output = { next: "escalation" };
  broken.promptHashes["planner.v1"] = "sha256:old";
  const found = fixtureProblems(broken, [...ALL_PROMPTS, ...FIX_PROMPTS]);
  assert.ok(found.some((p) => p.includes("output outside the schema")) && found.some((p) => p.includes("stale hash")), found.join("; "));
});

// Final review: the free-form fields that arrive via MCP (unauthenticated) and via the planner have a size cap.
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

// ---------- spec 009: code fixer contracts ----------

const sha40 = "a".repeat(40);
const sha64 = "b".repeat(64);
const run = () => ({
  outcome: "failed" as const, exitCode: 1, total: 4, passed: 3, failed: 1, skipped: 0, todo: 0, cancelled: 0, durationMs: 120,
  failures: [{ name: "repro", file: "tests/cart.test.js", errorName: "TypeError", message: "Cannot read properties of undefined", frames: [{ file: "src/cart.js", line: 12 }] }],
});
const frame = () => ({ file: "src/cart.js", line: 12, column: 5, function: "total", inApp: true });
const attempt = () => ({
  id: "fix_abc12345", incidentId: "INC-0001", repo: "acme/checkout-web", service: "checkout-web", connectorId: "sentry",
  errorGroupId: "12345", mode: "shadow", isolation: "isolated", status: "patch_ready", stage: "finalize", reason: null,
  violations: [], release: "checkout-web@" + sha40, commitSha: sha40, baseBranch: "main", baseCommitSha: sha40,
  exception: { type: "TypeError", value: "Cannot read properties of undefined" }, anchor: frame(),
  files: [{ path: "src/cart.js", role: "source", added: 1, removed: 1, afterSha256: sha64 }],
  patch: "diff --git a/src/cart.js b/src/cart.js\n", patchSha256: sha64,
  contents: [{ path: "src/cart.js", text: "export const total = () => 0;\n" }],
  evidence: { baseline: run(), reproBefore: [run(), run()], fixAfter: [], suiteAfter: null },
  review: { verdict: "approve", concerns: [] }, suggestion: null, approvalId: null, commit: null, pullRequest: null,
  llm: { calls: 3, promptTokens: 1000, completionTokens: 200 },
  startedAt: "2026-10-04T09:00:00.000Z", patchReadyAt: "2026-10-04T09:05:00.000Z", finishedAt: "2026-10-04T09:05:00.000Z", version: 2,
});

test("CodeFixAttemptSchema parses a full attempt and rejects a bad id, a non-hex sha and more than 3 files", async () => {
  const { CodeFixAttemptSchema } = await import("../../src/contracts/index.ts");
  assert.equal(CodeFixAttemptSchema.parse(attempt()).id, "fix_abc12345");
  assert.equal(CodeFixAttemptSchema.safeParse({ ...attempt(), id: "fix_ABC" }).success, false);
  assert.equal(CodeFixAttemptSchema.safeParse({ ...attempt(), id: "att_abc12345" }).success, false);
  assert.equal(CodeFixAttemptSchema.safeParse({ ...attempt(), commitSha: "z".repeat(40) }).success, false);
  assert.equal(CodeFixAttemptSchema.safeParse({ ...attempt(), patchSha256: "B".repeat(64) }).success, false);
  const f = attempt().files[0]!;
  assert.equal(CodeFixAttemptSchema.safeParse({ ...attempt(), files: [f, f, f, f] }).success, false);
  assert.equal(CodeFixAttemptSchema.safeParse({ ...attempt(), files: [f, f, f] }).success, true);
});

test("CodeFixAttemptViewSchema has no contents key", async () => {
  const { CodeFixAttemptViewSchema } = await import("../../src/contracts/index.ts");
  assert.equal(Object.keys(CodeFixAttemptViewSchema.shape).includes("contents"), false);
  const view = CodeFixAttemptViewSchema.parse(attempt());
  assert.equal("contents" in view, false);
  assert.equal(view.patch, attempt().patch);
});

test("model output schemas have no tier, approval, command, repo or publish key", async () => {
  const { FixTestProposalSchema, FixPatchProposalSchema, FixReviewSchema } = await import("../../src/contracts/index.ts");
  const banned = ["tier", "approval", "command", "repo", "repository", "publish"];
  for (const s of [FixTestProposalSchema, FixPatchProposalSchema, FixReviewSchema]) {
    for (const k of Object.keys(s.shape)) assert.ok(!banned.includes(k), k);
  }
  const edit = { path: "src/cart.js", search: "a", replace: "b" };
  assert.equal(FixPatchProposalSchema.safeParse({ edits: [], rationale: "x" }).success, false);
  assert.equal(FixPatchProposalSchema.safeParse({ edits: [edit, edit, edit], rationale: "x" }).success, false);
  assert.equal(FixPatchProposalSchema.safeParse({ edits: [edit, edit], rationale: "x" }).success, true);
  assert.equal(FixPatchProposalSchema.safeParse({ edits: [{ ...edit, search: "" }], rationale: "x" }).success, false);
  assert.equal(FixTestProposalSchema.safeParse({ test: { path: "tests/a.test.js", content: "x" }, rationale: "r" }).success, true);
  assert.equal(FixReviewSchema.safeParse({ verdict: "approve", concerns: ["a", "b", "c", "d", "e", "f"] }).success, false);
  assert.equal(FixReviewSchema.safeParse({ verdict: "maybe", concerns: [] }).success, false);
});

test("ApprovalSchema keeps action approvals byte-identical and accepts a code-fix subject", async () => {
  const { ApprovalSchema } = await import("../../src/contracts/index.ts");
  const base = {
    id: "APR-0001", incidentId: "INC-0001", actionId: "ACT-0001", status: "pending", requestedAt: "2026-10-04T09:00:00.000Z",
    expiresAt: "2026-10-04T09:15:00.000Z", decidedAt: null, approver: null, comment: null, decisionSource: null, version: 0,
  };
  const parsed = ApprovalSchema.parse(base);
  assert.equal("subject" in parsed, false);
  assert.equal("patchSha256" in parsed, false);
  assert.equal(JSON.stringify(parsed), JSON.stringify(base));
  const fix = ApprovalSchema.parse({ ...base, actionId: "fix_abc12345", subject: "code_fix", patchSha256: sha64 });
  assert.deepEqual([fix.subject, fix.patchSha256], ["code_fix", sha64]);
  assert.equal(ApprovalSchema.safeParse({ ...base, subject: "other" }).success, false);
  assert.equal(ApprovalSchema.safeParse({ ...base, patchSha256: "x" }).success, false);
});

test("StackFrameSchema, ErrorEventSchema and ReleaseCommitSchema parse and reject as specified", async () => {
  const { StackFrameSchema, ErrorEventSchema, ReleaseCommitSchema } = await import("../../src/contracts/index.ts");
  assert.equal(StackFrameSchema.safeParse(frame()).success, true);
  assert.equal(StackFrameSchema.safeParse({ ...frame(), column: null, function: null }).success, true);
  assert.equal(StackFrameSchema.safeParse({ ...frame(), line: 0 }).success, false);
  assert.equal(StackFrameSchema.safeParse({ ...frame(), column: -1 }).success, false);
  assert.equal(StackFrameSchema.safeParse({ ...frame(), inApp: undefined }).success, false);
  const event = { errorId: "12345", release: "1.2.3", firstSeen: "2026-10-04T09:00:00.000Z", exception: { type: "TypeError", value: "x" }, frames: [frame()] };
  assert.equal(ErrorEventSchema.safeParse(event).success, true);
  assert.equal(ErrorEventSchema.safeParse({ ...event, release: null, firstSeen: null }).success, true);
  assert.equal(ErrorEventSchema.safeParse({ ...event, firstSeen: "yesterday" }).success, false);
  assert.equal(ErrorEventSchema.safeParse({ ...event, frames: Array.from({ length: 51 }, frame) }).success, false);
  assert.equal(ErrorEventSchema.safeParse({ ...event, exception: { type: "TypeError", value: "v".repeat(301) } }).success, false);
  assert.equal(ReleaseCommitSchema.safeParse({ sha: sha40, repository: "acme/checkout-web" }).success, true);
  assert.equal(ReleaseCommitSchema.safeParse({ sha: sha40, repository: null }).success, true);
  assert.equal(ReleaseCommitSchema.safeParse({ sha: "abc123", repository: null }).success, false);
  assert.equal(ReleaseCommitSchema.safeParse({ sha: "A".repeat(40), repository: null }).success, false);
});

test("AgentIdSchema includes code_fixer and AuditEventSchema the six code_fix events", async () => {
  const { AgentIdSchema, AuditEventSchema } = await import("../../src/contracts/index.ts");
  assert.ok(AgentIdSchema.options.includes("code_fixer" as never));
  for (const e of ["code_fix_skipped", "code_fix_started", "code_fix_gave_up", "code_fix_patch_ready", "code_fix_pr_opened", "code_fix_publish_failed"]) {
    assert.ok(AuditEventSchema.options.includes(e as never), e);
  }
});
