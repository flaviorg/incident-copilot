import { test } from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import { FakeLlmProvider, FAKE_MODEL } from "../../src/llm/fake-provider.ts";
import { FixtureTurnSchema } from "../../src/llm/fixture-format.ts";
import type { FixtureFile, FixtureTurn } from "../../src/llm/fixture-format.ts";
import { promptHash } from "../../src/llm/prompt-hash.ts";
import { estimateTokens } from "../../src/llm/usage.ts";
import type { LlmResult, PromptDef, RunContext } from "../../src/llm/provider.ts";
import { FixturePromptDriftError, UnscriptedLlmCallError } from "../../src/domain/errors.ts";
import { errTurn, patchFixture, turn } from "../helpers/fixtures.ts";

const echo: PromptDef<{ n: number }, { ok: boolean }> = {
  id: "echo",
  version: "echo.v1",
  system: "Answer whether the number is accepted.",
  buildUser: (i) => `number: ${i.n}`,
  matchKeys: (i) => ({ n: i.n }),
  inputSchema: z.object({ n: z.number() }),
  outputSchema: z.object({ ok: z.boolean() }),
};
const ctx: RunContext = { incidentId: "INC-0001", runId: "RUN-0001", scenarioId: "s1", requestId: null, signal: new AbortController().signal };
const T = (id: string, when: FixtureTurn["when"], output: unknown) => turn(id, when, output, "echo.v1");
const E = (id: string, when: FixtureTurn["when"], kind: "timeout" | "server_error") => errTurn(id, when, kind, "echo.v1");
const fx = (turns: FixtureTurn[], hash = promptHash(echo)): FixtureFile => ({ schemaVersion: 1, scenarioId: "s1", promptHashes: { "echo.v1": hash }, turns });
const kindOf = (r: LlmResult<unknown>) => (r.success ? "ok" : r.error.kind);

test("consumes the first matching unconsumed turn in order", async () => {
  const f = new FakeLlmProvider({ fixtures: [fx([T("a", { n: 1 }, { ok: true }), T("b", { n: 1 }, { ok: false })])] });
  const first = await f.generate(echo, { n: 1 }, ctx);
  assert.ok(first.success && first.data.ok === true);
  const second = await f.generate(echo, { n: 1 }, ctx);
  assert.ok(second.success && second.data.ok === false);
  assert.deepEqual(f.consumedIds(), ["a", "b"]);
});

test("each incident replays the script from the start (same scenario, same process)", async () => {
  const f = new FakeLlmProvider({ fixtures: [fx([T("a", { n: 1 }, { ok: true }), T("b", { n: 1 }, { ok: false })])] });
  const other = { ...ctx, incidentId: "INC-0002", runId: "RUN-0002" };
  const r1 = await f.generate(echo, { n: 1 }, ctx);
  const r2 = await f.generate(echo, { n: 1 }, other);
  assert.ok(r1.success && r1.data.ok === true);
  assert.ok(r2.success && r2.data.ok === true, "the 2nd incident starts from the first turn");
  const r3 = await f.generate(echo, { n: 1 }, ctx);
  assert.ok(r3.success && r3.data.ok === false, "the 1st incident continues from where it stopped");
  assert.deepEqual(f.consumedIds(), ["a", "a", "b"]);
  f.assertAllConsumed(); // a e b foram consumidos por algum incidente
  await assert.rejects(f.generate(echo, { n: 1 }, ctx), (e) => e instanceof UnscriptedLlmCallError && e.turnsConsumed === 2);
});

test("unscripted call throws with diagnostics", async () => {
  const f = new FakeLlmProvider({ fixtures: [fx([T("a", { n: 1 }, { ok: true })])] });
  await assert.rejects(f.generate(echo, { n: 2 }, ctx), (e) =>
    e instanceof UnscriptedLlmCallError && e.scenarioId === "s1" && e.prompt === "echo.v1" && e.callNumber === 1
    && /^[0-9a-f]{64}$/.test(e.inputDigest) && e.turnsTotal === 1 && e.turnsConsumed === 0
    && (e.matchKeys as { n: number }).n === 2);
});

test("prompt drift throws before answering", async () => {
  const f = new FakeLlmProvider({ fixtures: [fx([T("a", { n: 1 }, { ok: true })], "sha256:old")] });
  await assert.rejects(f.generate(echo, { n: 1 }, ctx), (e) => e instanceof FixturePromptDriftError && /fixtures:rehash/.test(e.message));
  assert.deepEqual(f.consumedIds(), []);
});

test("simulated errors and schema-invalid outputs are failures", async () => {
  const f = new FakeLlmProvider({ fixtures: [fx([E("a", { n: 1 }, "server_error"), T("b", { n: 2 }, { ok: "nope" })])] });
  assert.equal(kindOf(await f.generate(echo, { n: 1 }, ctx)), "server_error");
  assert.equal(kindOf(await f.generate(echo, { n: 2 }, ctx)), "invalid_output");
});

test("delayMs honors the abort signal", async () => {
  const f = new FakeLlmProvider({ fixtures: [fx([{ ...T("a", { n: 1 }, { ok: true }), delayMs: 200 }])] });
  const t0 = Date.now();
  const r = await f.generate(echo, { n: 1 }, { ...ctx, signal: AbortSignal.timeout(20) });
  assert.equal(kindOf(r), "aborted");
  assert.ok(Date.now() - t0 < 150);
});

test("usage from turn or estimated; model fake/scripted; cost 0", async () => {
  const f = new FakeLlmProvider({ fixtures: [fx([{ ...T("a", { n: 1 }, { ok: true }), usage: { promptTokens: 812, completionTokens: 61 } }, T("b", { n: 2 }, { ok: true })])] });
  const a = await f.generate(echo, { n: 1 }, ctx);
  assert.ok(a.success);
  assert.deepEqual(a.usage, { promptTokens: 812, completionTokens: 61, costUsd: 0 });
  assert.equal(a.model, FAKE_MODEL);
  assert.equal(a.model, "fake/scripted");
  const b = await f.generate(echo, { n: 2 }, ctx);
  assert.ok(b.success);
  assert.equal(b.usage.promptTokens, estimateTokens(`${echo.system}\n${echo.buildUser({ n: 2 })}`));
  assert.equal(b.usage.completionTokens, estimateTokens(JSON.stringify({ ok: true })));
  assert.equal(b.usage.costUsd, 0);
  assert.equal(estimateTokens("abcde"), 2);
});

test("assertAllConsumed lists leftovers and honors except", async () => {
  const f = new FakeLlmProvider({ fixtures: [fx([T("a", { n: 1 }, { ok: true }), T("b", { n: 2 }, { ok: true })])] });
  await f.generate(echo, { n: 1 }, ctx);
  assert.throws(() => f.assertAllConsumed(), /\bb\b/);
  assert.doesNotThrow(() => f.assertAllConsumed({ except: ["b"] }));
  // Com scenarioId, só o roteiro daquele cenário conta (o container carrega as fixtures de todos).
  const other: FixtureFile = { ...fx([T("z", { n: 1 }, { ok: true })]), scenarioId: "s2" };
  const g = new FakeLlmProvider({ fixtures: [fx([T("a", { n: 1 }, { ok: true })]), other] });
  await g.generate(echo, { n: 1 }, ctx);
  assert.throws(() => g.assertAllConsumed(), /\bz\b/);
  assert.doesNotThrow(() => g.assertAllConsumed({ scenarioId: "s1" }));
  assert.throws(() => g.assertAllConsumed({ scenarioId: "s2" }), /\bz\b/);
});

test("calls() records prompt, matchKeys and user text", async () => {
  const f = new FakeLlmProvider({ fixtures: [fx([T("a", { n: 1 }, { ok: true })])] });
  await f.generate(echo, { n: 1 }, ctx);
  await assert.rejects(f.generate(echo, { n: 9 }, ctx));
  assert.deepEqual(f.calls(), [
    { prompt: "echo.v1", matchKeys: { n: 1 }, user: "number: 1", turnId: "a" },
    { prompt: "echo.v1", matchKeys: { n: 9 }, user: "number: 9", turnId: null },
  ]);
});

test("fixture schema rejects a turn with both output and error", () => {
  assert.equal(FixtureTurnSchema.safeParse({ id: "x", prompt: "p", when: {}, output: {}, error: { kind: "timeout" } }).success, false);
  assert.equal(FixtureTurnSchema.safeParse({ id: "x", prompt: "p", when: {} }).success, false);
  assert.throws(() => new FakeLlmProvider({ fixtures: [fx([]), fx([])] }), /s1/);
});

test("patchFixture replaces, removes, inserts and appends turns", () => {
  const base = fx([T("a", { n: 1 }, { ok: true }), T("b", { n: 2 }, { ok: true })]);
  const snapshot = structuredClone(base);
  const p = patchFixture(base, {
    replace: { a: { error: { kind: "timeout" } } },
    remove: ["b"],
    insertBefore: { a: [errTurn("e1", { n: 1 }, "server_error")] },
    append: [T("c", { n: 3 }, { ok: false })],
  });
  assert.deepEqual(p.turns.map((t) => t.id), ["e1", "a", "c"]);
  assert.equal(p.turns[0]!.prompt, "echo.v1");
  assert.equal(p.turns[1]!.output, undefined);
  assert.deepEqual(p.turns[1]!.error, { kind: "timeout" });
  assert.deepEqual(base, snapshot);
  assert.throws(() => patchFixture(base, { remove: ["zz"] }), /zz/);
});
