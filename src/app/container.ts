// Compõe tudo a partir da config: única fonte usada por API, MCP, CLI e testes. Sem estado global.
// Cresce nas tarefas 15, 22, 29, 34 e 35.
import type { Config } from "../config.ts";
import { collectSecrets } from "../infra/redact.ts";
import { createLogger } from "../infra/logger.ts";
import type { Logger } from "../infra/logger.ts";
import { openDatabase } from "../infra/db/sqlite.ts";
import { SqliteIncidentStore } from "../infra/db/incident-store.ts";
import { DbIds } from "../infra/ids.ts";
import type { Ids } from "../infra/ids.ts";
import { SimulatedClock, SystemClock } from "../infra/clock.ts";
import type { Clock } from "../infra/clock.ts";
import { ScenarioRepository } from "../infra/scenarios/scenario-loader.ts";
import type { LoadedScenario } from "../infra/scenarios/scenario-loader.ts";
import { RunbookRepository } from "../infra/runbooks/runbook-repository.ts";
import { createToolRegistry } from "../tools/registry.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { CloudPrices } from "../domain/finops/inventory-audit.ts";
import type { BusinessAssumptions } from "../domain/metrics/incident-metrics.ts";
import { BusinessAssumptionsSchema, CloudPricesSchema, ModelPricesSchema, loadDataFile } from "../infra/data-files.ts";
import { projectPath } from "../infra/paths.ts";
import { loadFixtures } from "../llm/fixture-format.ts";
import type { FixtureFile } from "../llm/fixture-format.ts";
import { createLlmProvider } from "../llm/create-provider.ts";
import type { FakeLlmProvider } from "../llm/fake-provider.ts";
import type { LlmProvider } from "../llm/provider.ts";
import type { ModelPrices } from "../llm/usage.ts";
import { DEFAULT_LIMITS } from "../contracts/index.ts";
import type { Limits } from "../contracts/index.ts";
import { TraceSink } from "./trace-sink.ts";
import { IncidentService } from "./incident-service.ts";
import { ApprovalService } from "./approval-service.ts";
import { StatsService } from "./stats-service.ts";
import { TokenAttemptLimiter } from "../domain/guards/token-attempt-limiter.ts";
import { SimulatedInfra } from "../infra/simulated-infra.ts";
import { effectiveStatus } from "../domain/approval/approval-machine.ts";
import { catalogPromptText, isMitigating } from "../domain/autonomy/catalog.ts";
import { buildIncidentGraph } from "../graph/graph.ts";
import type { GraphNodes } from "../graph/graph.ts";
import { createSupervisorNode } from "../graph/nodes/supervisor-node.ts";
import { createTelemetryNode } from "../graph/nodes/telemetry-node.ts";
import { createRunbooksNode } from "../graph/nodes/runbooks-node.ts";
import { createPlannerNode } from "../graph/nodes/planner-node.ts";
import { createAuditorNode } from "../graph/nodes/auditor-node.ts";
import { createReporterNode } from "../graph/nodes/reporter-node.ts";
import { createEscalationNode } from "../graph/nodes/escalation-node.ts";
import { createGateNode } from "../graph/nodes/gate-node.ts";
import { createExecutorNode } from "../graph/nodes/executor-node.ts";
import type { ExecutionGuards } from "../graph/nodes/executor-node.ts";
import { createVerifierNode } from "../graph/nodes/verifier-node.ts";
import { CircuitBreaker } from "../domain/guards/circuit-breaker.ts";
import { ActionRateLimiter } from "../domain/guards/action-rate-limiter.ts";
import type { GatePersist } from "../graph/nodes/gate-node.ts";

export type Container = {
  config: Config;
  secrets: string[];
  logger: Logger;
  store: SqliteIncidentStore;
  ids: Ids;
  clock: Clock;
  scenarios: ScenarioRepository;
  runbooks: RunbookRepository;
  tools: ToolRegistry;
  prices: CloudPrices;
  /** Mundo simulado: dry run, execução, reversão e sinais pós-ação. */
  infra: SimulatedInfra;
  assumptions: BusinessAssumptions;
  modelPrices: ModelPrices;
  /** Provedor com timeout, retry, fallback (openrouter) e registro de chamadas. */
  llm: LlmProvider;
  /** O fake por baixo de `llm` quando o provedor é fake (testes usam calls() e assertAllConsumed()); senão null. */
  fake: FakeLlmProvider | null;
  /** Tetos do spec 6.2, com os ajustes injetados (testes). */
  limits: Limits;
  /** Circuit breaker e limite de execuções, por processo (spec 6.7). */
  guards: ExecutionGuards;
  trace: TraceSink;
  /** Abre, executa, retoma e lê incidentes (as três portas usam só isto). */
  incidents: IncidentService;
  /** Decisões humanas com token; a última decisão do lote dispara a retomada. */
  approvals: ApprovalService;
  /** Tentativas de token erradas, por processo (5 em 10 min bloqueiam 10 min). */
  attempts: TokenAttemptLimiter;
  /** Agregações do /stats por SQL. */
  stats: StatsService;
  close(): void;
};

export type ContainerOverrides = {
  clock?: Clock;
  transformScenario?: (s: LoadedScenario) => LoadedScenario;
  logWrite?: (line: string) => void;
  /** Fixtures do provedor fake; padrão: fixtures/llm/*.json. */
  fixtures?: FixtureFile[];
  limits?: Partial<Limits>;
  /** Só para testes: troca nós do grafo (por exemplo, parar no portão para testar o nó isolado). */
  nodes?: Partial<GraphNodes>;
  /** Só para testes: breaker já aberto ou limiter já cheio (spec 7.4). */
  guards?: Partial<ExecutionGuards>;
};

/** Início do relógio simulado antes do primeiro alinhamento (open alinha ao detectedAt do cenário). */
const SIMULATED_CLOCK_START = new Date("2026-10-04T00:00:00.000Z");

export function createContainer(config: Config, o: ContainerOverrides = {}): Container {
  const secrets = collectSecrets(config);
  const logger = createLogger({ level: config.logLevel, secrets, ...(o.logWrite ? { write: o.logWrite } : {}) });
  const clock = o.clock ?? (config.clock === "simulated" ? new SimulatedClock(SIMULATED_CLOCK_START) : new SystemClock());
  const db = openDatabase(config.dbPath);
  const store = new SqliteIncidentStore(db, { secrets, now: () => clock.now() });
  const ids = new DbIds(store);
  const scenarios = new ScenarioRepository({
    rootDir: projectPath("fixtures", "scenarios"),
    ...(o.transformScenario ? { transform: o.transformScenario } : {}),
  });
  const runbooks = new RunbookRepository(projectPath("runbooks"));
  const prices = loadDataFile(projectPath("data", "cloud-prices.json"), CloudPricesSchema);
  const assumptions = loadDataFile(projectPath("data", "business-assumptions.json"), BusinessAssumptionsSchema);
  const modelPrices = loadDataFile(projectPath("data", "model-prices.json"), ModelPricesSchema);
  const tools = createToolRegistry({ prices });
  const infra = new SimulatedInfra({ prices });
  const fixtures = o.fixtures ?? (config.llmProvider === "fake" ? loadFixtures(projectPath("fixtures", "llm")) : []);
  const { provider: llm, fake } = createLlmProvider(config, { fixtures, prices: modelPrices, store, clock });
  const limits: Limits = { ...DEFAULT_LIMITS, ...o.limits };
  const trace = new TraceSink({ store, ids, clock, secrets });

  // Equipe (Tarefa 22).
  const escalation = createEscalationNode({ trace, audit: (e) => store.appendAudit(e) });
  const reporter = createReporterNode({
    llm, providerName: config.llmProvider, trace, clock, scenarios, assumptions,
    read: {
      trace: (id) => store.listTrace(id),
      approvals: (id) => store.listApprovals({ incidentId: id }),
      llmCalls: (id) => store.listLlmCalls(id),
    },
    savingsFor: (a, bb) => infra.monthlySavingsFor(a, bb.world),
    isMitigating,
  });
  const persist: GatePersist = {
    action: (a) => store.upsertAction(a),
    approval: (a) => store.createApproval(a),
    audit: (e) => store.appendAudit(e),
  };
  const guards: ExecutionGuards = {
    breaker: o.guards?.breaker ?? new CircuitBreaker({ failureThreshold: config.circuitFailureThreshold, cooldownSec: config.circuitCooldownSec }),
    limiter: o.guards?.limiter ?? new ActionRateLimiter({ perMinute: config.actionRateLimitPerMin, repeatWindowMin: config.actionRepeatWindowMin }),
  };
  const execution = { infra, scenarios, guards, trace, clock, persist };
  const nodes: GraphNodes = {
    supervisor: createSupervisorNode({ llm, trace, limits }),
    telemetry_analyst: createTelemetryNode({ llm, tools, scenarios, trace, clock, limits }),
    runbook_retriever: createRunbooksNode({ runbooks, trace }),
    remediation_planner: createPlannerNode({ llm, trace, catalogText: catalogPromptText }),
    auditor: createAuditorNode({ llm, trace, scenarios, limits }),
    gate: createGateNode({ infra, trace, clock, ids, approvalTtlMin: config.approvalTtlMin, persist }),
    executor: createExecutorNode(execution),
    verifier: createVerifierNode(execution),
    reporter,
    escalation,
    ...o.nodes,
  };
  const graph = buildIncidentGraph(nodes, {
    limits,
    pendingApprovals: (incidentId) => store.listApprovals({ incidentId }).filter((a) => effectiveStatus(a, clock.now()) === "pending").length,
    isMitigating,
  });
  const incidents = new IncidentService({
    store, scenarios, graph, clock, ids, limits, runTimeoutMs: config.runTimeoutMs, logger,
    infra: { initialWorld: (s) => infra.initialWorld(s), dryRun: (w, step) => infra.dryRun(w, step) },
    direct: { escalation, reporter },
    trace,
    approvalTtlMin: config.approvalTtlMin,
  });

  const attempts = new TokenAttemptLimiter();
  const approvals = new ApprovalService({ store, incidents, clock, approvalToken: config.approvalToken, attempts, secrets, logger });
  const stats = new StatsService({ db, clock });

  let closed = false;
  return {
    config, secrets, logger, store, ids, clock, scenarios, runbooks, tools, prices, infra, assumptions, modelPrices, llm, fake, limits, guards, trace, incidents, approvals, attempts, stats,
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
