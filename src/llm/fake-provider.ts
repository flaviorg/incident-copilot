// Provedor fake roteirizado (spec 7.1 e 7.2): prova a mecânica, não a qualidade do modelo.
// Cada resposta está numa fixture por cenário; chamada sem turno correspondente lança, para o teste quebrar.
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
/** Consumo para a correspondência: por incidente, para cada incidente tocar o roteiro do começo (API e MCP de longa duração). */
const incidentTurnKey = (incidentId: string, scenarioId: string, turnId: string) => `${incidentId}\u0000${scenarioId}\u0000${turnId}`;

/** Espera `ms` ou até o sinal abortar; devolve false se abortou. */
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
  /** Turnos consumidos por algum incidente (modo estrito). */
  private readonly consumed = new Set<string>();
  /** Turnos consumidos por incidente (correspondência, regra 2). */
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

    // Regra 1: hash do prompt antes de responder.
    const actual = promptHash(prompt);
    if (file) {
      const expected = file.promptHashes[prompt.version] ?? null;
      if (expected !== actual) throw new FixturePromptDriftError({ prompt: prompt.version, expected, actual });
    }

    const matchKeys = prompt.matchKeys(input);
    const user = prompt.buildUser(input);
    const call: FakeCall = { prompt: prompt.version, matchKeys: { ...matchKeys }, user, turnId: null };
    this.log.push(call);

    // Regra 2: primeiro turno ainda não consumido por este incidente, daquele prompt, cujo `when` é subconjunto das chaves.
    // O consumo é por incidente: num processo de longa duração (API, MCP), o 2º incidente do mesmo cenário toca o
    // roteiro desde o começo em vez de esbarrar nos turnos gastos pelo 1º.
    const usedHere = (t: FixtureTurn) => this.consumedByIncident.has(incidentTurnKey(ctx.incidentId, ctx.scenarioId, t.id));
    const found = file
      ? ofPrompt.find((t) => !usedHere(t) && Object.entries(t.when).every(([k, v]) => matchKeys[k] === v))
      : undefined;
    if (!file || !found) {
      // Regra 3: sem turno, erro com diagnóstico.
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

    // Regra 6: atraso abortável pelo sinal da chamada.
    if (found.delayMs !== undefined && found.delayMs > 0) {
      const finished = await sleep(found.delayMs, ctx.signal);
      if (!finished) return llmFailure("aborted", `call aborted during the simulated delay of turn ${found.id}`, FAKE_MODEL);
    } else if (ctx.signal.aborted) {
      return llmFailure("aborted", `call aborted before the response of turn ${found.id}`, FAKE_MODEL);
    }

    // Regra 5: falha simulada.
    if (found.error) return llmFailure(found.error.kind, `failure simulated by the fixture (turn ${found.id})`, FAKE_MODEL);

    // Regra 4: a saída passa pelo schema como se viesse do modelo.
    const parsed = prompt.outputSchema.safeParse(found.output);
    if (!parsed.success) {
      const where = parsed.error.issues.map((i) => i.path.map(String).join(".") || "(root)").join(", ");
      return llmFailure("invalid_output", `output of turn ${found.id} does not match the ${prompt.version} schema at ${where}`, FAKE_MODEL);
    }

    // Regra 7: uso do turno ou estimado; custo 0.
    const usage = found.usage ?? {
      promptTokens: estimateTokens(`${prompt.system}\n${user}`),
      completionTokens: estimateTokens(JSON.stringify(found.output)),
    };
    return { success: true, data: parsed.data, usage: { ...usage, costUsd: 0 }, model: FAKE_MODEL, latencyMs: found.delayMs ?? 0 };
  }

  /**
   * Modo estrito (regra 8): lança listando os turnos que nenhum incidente consumiu, exceto os de `except`.
   * Com `scenarioId`, confere só o roteiro daquele cenário (o container carrega as fixtures de todos os cenários).
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

  /** Registro de entradas (regra 9, só teste). */
  calls(): FakeCall[] {
    return this.log.map((c) => ({ ...c, matchKeys: { ...c.matchKeys } }));
  }

  consumedIds(): string[] {
    return [...this.consumedOrder];
  }

  /** Turnos do cenário (útil para derivar fixtures em código). */
  turnsOf(scenarioId: string): FixtureTurn[] {
    return [...(this.files.get(scenarioId)?.turns ?? [])];
  }
}
