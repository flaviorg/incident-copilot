// Test container (spec 8.1): :memory:, simulated clock, sequential ids, explicit fake and captured logs.
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
import type { CopilotConfig } from "../../src/infra/copilot-config/schema.ts";
import type { ConnectorDefinition } from "../../src/connectors/types.ts";
import type { NotifierDefinition } from "../../src/notifiers/types.ts";

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
  /** Extra variables for loadConfig (e.g. fake OPENROUTER_API_KEY); LLM_PROVIDER stays fake and the options above win. */
  env?: Record<string, string>;
  /** Live mode (spec 008): a parsed copilot config and the definitions it was parsed with. */
  copilot?: CopilotConfig | null;
  connectorDefinitions?: readonly ConnectorDefinition<unknown>[];
  notifierDefinitions?: readonly NotifierDefinition<unknown>[];
  /** Transport of connectors and notifiers (tests/helpers/fake-fetch.ts). */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export type TestContainer = Container & { fake: FakeLlmProvider; logs: string[] };

/** The given fixture (object or path from the root) replaces the one with the same scenarioId in fixtures/llm. */
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
    ...(o.copilot !== undefined ? { copilot: o.copilot } : {}),
    ...(o.connectorDefinitions ? { connectorDefinitions: o.connectorDefinitions } : {}),
    ...(o.notifierDefinitions ? { notifierDefinitions: o.notifierDefinitions } : {}),
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
  });
  if (!c.fake) throw new Error("test container without a fake provider");
  return { ...c, fake: c.fake, logs };
}

/** Saved incident (row, blackboard and audit) and initial blackboard with its own runId, for testing isolated nodes. */
export function initialBlackboard(c: Container, scenarioId: string): Blackboard {
  const { blackboard } = openIncidentRecord(
    { store: c.store, scenarios: c.scenarios, clock: c.clock, ids: c.ids, initialWorld: (s) => c.infra.initialWorld(s) },
    { scenarioId },
    { requestId: null },
  );
  return { ...blackboard, runId: c.ids.run() };
}

export function nodeDeps(c: Container) {
  return { llm: c.llm, tools: c.tools, context: c.context, trace: c.trace, clock: c.clock, limits: c.limits };
}

export function countByType(events: TraceEvent[]): Partial<Record<TraceType, number>> {
  const out: Partial<Record<TraceType, number>> = {};
  for (const e of events) out[e.type] = (out[e.type] ?? 0) + 1;
  return out;
}

/** Id of the container's most recent incident (each test container has its own database). */
export function incidentIdOf(c: Container): string {
  const first = c.store.listIncidents({ limit: 1 })[0];
  if (!first) throw new Error("no incident in the container");
  return first.id;
}

class StopAtGate extends Error {
  constructor() {
    super("stopped at the gate by the test");
    this.name = "StopAtGate";
  }
}

/**
 * Runs the team up to the gate with c.incidents.open, in a container whose gate node only stores the received state and stops the
 * execution. Returns the container and that state (the blackboard the gate would receive), with an optional extra step
 * appended to the end of the plan.
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
  if (captured === null) throw new Error(`the team did not reach the gate in scenario ${scenarioId}`);
  let bb: Blackboard = captured;
  if (extraStep) {
    const steps = bb.plan!.steps;
    const step: PlanStep = { order: steps.length + 1, params: {}, rationale: "extra test step", runbookRef: steps[0]!.runbookRef, dependsOn: [], ...extraStep };
    bb = { ...bb, plan: { ...bb.plan!, steps: [...steps, step] } };
  }
  return { c, bb };
}
