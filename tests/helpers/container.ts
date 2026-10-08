// Container de teste (spec 8.1): :memory:, relógio simulado, ids sequenciais, fake explícito e logs capturados.
import { loadConfig } from "../../src/config.ts";
import { createContainer } from "../../src/app/container.ts";
import type { Container } from "../../src/app/container.ts";
import { openIncidentRecord } from "../../src/app/incident-setup.ts";
import { loadFixtures } from "../../src/llm/fixture-format.ts";
import type { FixtureFile } from "../../src/llm/fixture-format.ts";
import type { FakeLlmProvider } from "../../src/llm/fake-provider.ts";
import type { LoadedScenario } from "../../src/infra/scenarios/scenario-loader.ts";
import { projectPath } from "../../src/infra/paths.ts";
import type { Blackboard, Limits, PlanStep, TraceEvent, TraceType } from "../../src/contracts/index.ts";
import type { GraphNodes } from "../../src/graph/graph.ts";
import type { ExecutionGuards } from "../../src/graph/nodes/executor-node.ts";
import { readFixture } from "./fixtures.ts";

export const TEST_APPROVAL_TOKEN = "test-token-0123456789";

export type TestContainerOptions = {
  fixture?: FixtureFile | string;
  limits?: Partial<Limits>;
  transformScenario?: (s: LoadedScenario) => LoadedScenario;
  approvalToken?: string | null;
  runTimeoutMs?: number;
  llmTimeoutMs?: number;
  dbPath?: string;
  nodes?: Partial<GraphNodes>;
  guards?: Partial<ExecutionGuards>;
  /** Variáveis extras para o loadConfig (ex.: OPENROUTER_API_KEY falsa); LLM_PROVIDER continua fake e as opções acima vencem. */
  env?: Record<string, string>;
};

export type TestContainer = Container & { fake: FakeLlmProvider; logs: string[] };

/** A fixture dada (objeto ou caminho a partir da raiz) substitui a do mesmo scenarioId em fixtures/llm. */
export function createTestContainer(o: TestContainerOptions = {}): TestContainer {
  const env: Record<string, string | undefined> = {
    ...o.env,
    DB_PATH: o.dbPath ?? ":memory:",
    LLM_PROVIDER: "fake",
    CLOCK: "simulated",
    LOG_LEVEL: "debug",
    APPROVAL_TOKEN: o.approvalToken === null ? undefined : (o.approvalToken ?? TEST_APPROVAL_TOKEN),
    RUN_TIMEOUT_MS: o.runTimeoutMs === undefined ? undefined : String(o.runTimeoutMs),
    LLM_TIMEOUT_MS: o.llmTimeoutMs === undefined ? undefined : String(o.llmTimeoutMs),
  };
  const config = loadConfig(env);
  let fixtures = loadFixtures(projectPath("fixtures", "llm"));
  if (o.fixture !== undefined) {
    const given = typeof o.fixture === "string" ? readFixture(o.fixture) : o.fixture;
    fixtures = [...fixtures.filter((f) => f.scenarioId !== given.scenarioId), given];
  }
  const logs: string[] = [];
  const c = createContainer(config, {
    fixtures,
    logWrite: (line) => void logs.push(line),
    ...(o.limits ? { limits: o.limits } : {}),
    ...(o.transformScenario ? { transformScenario: o.transformScenario } : {}),
    ...(o.nodes ? { nodes: o.nodes } : {}),
    ...(o.guards ? { guards: o.guards } : {}),
  });
  if (!c.fake) throw new Error("container de teste sem provedor fake");
  return { ...c, fake: c.fake, logs };
}

/** Incidente gravado (linha, blackboard e auditoria) e blackboard inicial com runId próprio, para testar nós isolados. */
export function initialBlackboard(c: Container, scenarioId: string): Blackboard {
  const { blackboard } = openIncidentRecord(
    { store: c.store, scenarios: c.scenarios, clock: c.clock, ids: c.ids, initialWorld: (s) => c.infra.initialWorld(s) },
    { scenarioId },
    { requestId: null },
  );
  return { ...blackboard, runId: c.ids.run() };
}

export function nodeDeps(c: Container) {
  return { llm: c.llm, tools: c.tools, scenarios: c.scenarios, trace: c.trace, clock: c.clock, limits: c.limits };
}

export function countByType(events: TraceEvent[]): Partial<Record<TraceType, number>> {
  const out: Partial<Record<TraceType, number>> = {};
  for (const e of events) out[e.type] = (out[e.type] ?? 0) + 1;
  return out;
}

/** Id do incidente mais recente do container (cada container de teste tem banco próprio). */
export function incidentIdOf(c: Container): string {
  const first = c.store.listIncidents({ limit: 1 })[0];
  if (!first) throw new Error("nenhum incidente no container");
  return first.id;
}

class StopAtGate extends Error {
  constructor() {
    super("parado no portão pelo teste");
    this.name = "StopAtGate";
  }
}

/**
 * Roda a equipe até o portão com c.incidents.open, num container cujo nó gate só guarda o estado recebido e para a
 * execução. Devolve o container e esse estado (o blackboard que o portão receberia), com um passo extra opcional
 * anexado ao fim do plano.
 */
export async function stateAtGate(
  scenarioId: string,
  opts: TestContainerOptions & { extraStep?: Partial<PlanStep> & Pick<PlanStep, "actionType" | "target"> } = {},
): Promise<{ c: TestContainer; bb: Blackboard }> {
  let captured: Blackboard | null = null;
  const { extraStep, ...rest } = opts;
  const c = createTestContainer({
    ...rest,
    nodes: {
      ...rest.nodes,
      gate: async (s) => {
        captured = s;
        throw new StopAtGate();
      },
    },
  });
  await c.incidents.open({ scenarioId }, { requestId: null }).catch((e: unknown) => {
    if (!(e instanceof StopAtGate)) throw e;
  });
  if (captured === null) throw new Error(`a equipe não chegou ao portão no cenário ${scenarioId}`);
  let bb: Blackboard = captured;
  if (extraStep) {
    const steps = bb.plan!.steps;
    const step: PlanStep = { order: steps.length + 1, params: {}, rationale: "passo extra do teste", runbookRef: steps[0]!.runbookRef, dependsOn: [], ...extraStep };
    bb = { ...bb, plan: { ...bb.plan!, steps: [...steps, step] } };
  }
  return { c, bb };
}
