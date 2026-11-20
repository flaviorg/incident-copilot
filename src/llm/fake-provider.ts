// Scripted fake provider (spec 7.1 and 7.2): proves the mechanics, not the model's quality.
// Each reply lives in a per-scenario fixture; a call with no matching turn throws, so the test breaks.
import { canonicalJson } from "../domain/canonical-json.ts";
import { FixturePromptDriftError, UnscriptedLlmCallError } from "../domain/errors.ts";
import { sha256Hex } from "../infra/crypto.ts";
import type { FixtureFile, FixtureTurn } from "./fixture-format.ts";
import { promptHash } from "./prompt-hash.ts";
import { estimateTokens } from "./usage.ts";
import { llmFailure } from "./provider.ts";
import type { LlmProvider, LlmResult, PromptDef, RunContext } from "./provider.ts";

export const FAKE_MODEL = "fake/scripted";

export type FakeCall = { prompt: string; matchKeys: Record<string, unknown>; user: string; turnId: string | null };

const turnKey = (scenarioId: string, turnId: string) => `${scenarioId}\u0000${turnId}`;
/** Consumption for matching: per incident, so each incident plays the script from the start (long-lived API and MCP). */
const incidentTurnKey = (incidentId: string, scenarioId: string, turnId: string) => `${incidentId}\u0000${scenarioId}\u0000${turnId}`;

/** Waits `ms` or until the signal aborts; returns false if it aborted. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class FakeLlmProvider implements LlmProvider {
  readonly name = "fake" as const;
  private readonly files = new Map<string, FixtureFile>();
  /** Turns consumed by any incident (strict mode). */
  private readonly consumed = new Set<string>();
  /** Turns consumed per incident (matching, rule 2). */
  private readonly consumedByIncident = new Set<string>();
  private readonly consumedOrder: string[] = [];
  private readonly log: FakeCall[] = [];
  private callCount = 0;

  constructor(o: { fixtures: FixtureFile[] }) {
    for (const f of o.fixtures) {
      if (this.files.has(f.scenarioId)) throw new Error(`duplicate fixture for scenario ${f.scenarioId}`);
      this.files.set(f.scenarioId, f);
    }
  }

  async generate<I, O>(prompt: PromptDef<I, O>, input: I, ctx: RunContext): Promise<LlmResult<O>> {
    this.callCount += 1;
    const callNumber = this.callCount;
    const file = this.files.get(ctx.scenarioId);
    const ofPrompt = file ? file.turns.filter((t) => t.prompt === prompt.version) : [];

    // Rule 1: prompt hash before answering.
    const actual = promptHash(prompt);
    if (file) {
      const expected = file.promptHashes[prompt.version] ?? null;
      if (expected !== actual) throw new FixturePromptDriftError({ prompt: prompt.version, expected, actual });
    }

    const matchKeys = prompt.matchKeys(input);
    const user = prompt.buildUser(input);
    const call: FakeCall = { prompt: prompt.version, matchKeys: { ...matchKeys }, user, turnId: null };
    this.log.push(call);

    // Rule 2: first turn not yet consumed by this incident, for that prompt, whose `when` is a subset of the keys.
    // Consumption is per incident: in a long-lived process (API, MCP), the 2nd incident of the same scenario plays the
    // script from the start instead of bumping into the turns spent by the 1st.
    const usedHere = (t: FixtureTurn) => this.consumedByIncident.has(incidentTurnKey(ctx.incidentId, ctx.scenarioId, t.id));
    const found = file
      ? ofPrompt.find((t) => !usedHere(t) && Object.entries(t.when).every(([k, v]) => matchKeys[k] === v))
      : undefined;
    if (!file || !found) {
      // Rule 3: no turn, error with a diagnosis.
      throw new UnscriptedLlmCallError({
        scenarioId: ctx.scenarioId,
        prompt: prompt.version,
        callNumber,
        inputDigest: sha256Hex(canonicalJson(input)),
        matchKeys: { ...matchKeys },
        turnsTotal: ofPrompt.length,
        turnsConsumed: file ? ofPrompt.filter(usedHere).length : 0,
      });
    }
    this.consumed.add(turnKey(file.scenarioId, found.id));
    this.consumedByIncident.add(incidentTurnKey(ctx.incidentId, file.scenarioId, found.id));
    this.consumedOrder.push(found.id);
    call.turnId = found.id;

    // Rule 6: delay abortable by the call's signal.
    if (found.delayMs !== undefined && found.delayMs > 0) {
      const finished = await sleep(found.delayMs, ctx.signal);
      if (!finished) return llmFailure("aborted", `call aborted during the simulated delay of turn ${found.id}`, FAKE_MODEL);
    } else if (ctx.signal.aborted) {
      return llmFailure("aborted", `call aborted before the response of turn ${found.id}`, FAKE_MODEL);
    }

    // Rule 5: simulated failure.
    if (found.error) return llmFailure(found.error.kind, `failure simulated by the fixture (turn ${found.id})`, FAKE_MODEL);

    // Rule 4: the output goes through the schema as if it came from the model.
    const parsed = prompt.outputSchema.safeParse(found.output);
    if (!parsed.success) {
      const where = parsed.error.issues.map((i) => i.path.map(String).join(".") || "(root)").join(", ");
      return llmFailure("invalid_output", `output of turn ${found.id} does not match the ${prompt.version} schema at ${where}`, FAKE_MODEL);
    }

    // Rule 7: the turn's usage or an estimate; cost 0.
    const usage = found.usage ?? {
      promptTokens: estimateTokens(`${prompt.system}\n${user}`),
      completionTokens: estimateTokens(JSON.stringify(found.output)),
    };
    return { success: true, data: parsed.data, usage: { ...usage, costUsd: 0 }, model: FAKE_MODEL, latencyMs: found.delayMs ?? 0 };
  }

  /**
   * Strict mode (rule 8): throws listing the turns no incident consumed, except those in `except`.
   * With `scenarioId`, checks only that scenario's script (the container loads the fixtures of all scenarios).
   */
  assertAllConsumed(o: { except?: string[]; scenarioId?: string } = {}): void {
    const except = new Set(o.except ?? []);
    const left: string[] = [];
    for (const f of this.files.values()) {
      if (o.scenarioId !== undefined && f.scenarioId !== o.scenarioId) continue;
      for (const t of f.turns) if (!this.consumed.has(turnKey(f.scenarioId, t.id)) && !except.has(t.id)) left.push(t.id);
    }
    if (left.length > 0) throw new Error(`fixture turns not consumed: ${left.join(", ")}`);
  }

  /** Input log (rule 9, test only). */
  calls(): FakeCall[] {
    return this.log.map((c) => ({ ...c, matchKeys: { ...c.matchKeys } }));
  }

  consumedIds(): string[] {
    return [...this.consumedOrder];
  }

  /** Scenario turns (useful for deriving fixtures in code). */
  turnsOf(scenarioId: string): FixtureTurn[] {
    return [...(this.files.get(scenarioId)?.turns ?? [])];
  }
}
