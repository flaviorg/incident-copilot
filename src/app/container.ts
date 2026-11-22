// Builds everything from the config: the single source used by the API, MCP, CLI and tests. No global state.
// Grew in tasks 15, 22, 29, 34 and 35.
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
import { missingPrices } from "../llm/usage.ts";
import { DEFAULT_LIMITS } from "../contracts/index.ts";
import type { Limits } from "../contracts/index.ts";
import { TraceSink } from "./trace-sink.ts";
import { createIncidentContextResolver } from "./incident-context.ts";
import type { IncidentContextResolver } from "../tools/context.ts";
import { createRunSlots } from "./run-slots.ts";
import type { RunSlots } from "./run-slots.ts";
import { createAlertQueue } from "./alert-queue.ts";
import type { AlertQueue } from "./alert-queue.ts";
import { createIngestService } from "./ingest-service.ts";
import type { IngestService } from "./ingest-service.ts";
import { createNotificationService } from "./notification-service.ts";
import type { NotificationReadModel, NotificationService } from "./notification-service.ts";
import type { CopilotConfig } from "../infra/copilot-config/schema.ts";
import { DEFAULT_INGEST } from "../infra/copilot-config/schema.ts";
import { createConnectorRegistry } from "../connectors/registry.ts";
import type { ConnectorRegistry } from "../connectors/registry.ts";
import { CONNECTOR_DEFINITIONS } from "../connectors/index.ts";
import type { ConnectorDefinition } from "../connectors/types.ts";
import { createHttpClient } from "../connectors/shared/http.ts";
import { NOTIFIER_DEFINITIONS } from "../notifiers/index.ts";
import type { NotifierDefinition } from "../notifiers/types.ts";
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
import { resolve as resolvePath } from "node:path";
import { SqliteCodeFixStore } from "../infra/db/code-fix-store.ts";
import { effectiveLimits } from "../domain/code-fix/limits.ts";
import type { CodeHostReader, GitWorkspacePort, SandboxRunner, Workspace } from "../domain/code-fix/ports.ts";
import type { CodeFixGraphNodes } from "../graph/code-fix/graph.ts";
import { GitCliWorkspace } from "../infra/code-fix/git-workspace.ts";
import { ProcessSandboxRunner } from "../infra/code-fix/process-sandbox.ts";
import { runSandboxSelfTest } from "../infra/code-fix/sandbox-self-test.ts";
import { createGitHubReader, createGitHubWriter } from "../codehost/github/client.ts";
import { aliasFor } from "../domain/ingest/service-map.ts";
import { redactSecrets } from "../infra/redact.ts";
import { CodeFixService, createCodeFixNodes, sha256Hex } from "./code-fix-service.ts";
import type { SandboxSelfTestOutcome } from "./code-fix-service.ts";
import { CodeFixPublisher } from "./code-fix-publisher.ts";

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
  /** Simulated world: dry run, execution, revert and post-action signals. */
  infra: SimulatedInfra;
  assumptions: BusinessAssumptions;
  modelPrices: ModelPrices;
  /** Provider with timeout, retry, fallback (openrouter) and call recording. */
  llm: LlmProvider;
  /** The fake under `llm` when the provider is fake (tests use calls() and assertAllConsumed()); otherwise null. */
  fake: FakeLlmProvider | null;
  /** Caps from spec 6.2, with injected overrides (tests). */
  limits: Limits;
  /** Circuit breaker and execution limit, per process (spec 6.7). */
  guards: ExecutionGuards;
  trace: TraceSink;
  /** Scenario or live context of an incident, for the nodes that read data (spec 008, decision 5). */
  context: IncidentContextResolver;
  /** Opens, runs, resumes and reads incidents (the three ports use only this). */
  incidents: IncidentService;
  /** Human decisions with a token; the batch's last decision triggers the resume. */
  approvals: ApprovalService;
  /** Wrong token attempts, per process (5 in 10 min lock for 10 min). */
  attempts: TokenAttemptLimiter;
  /** /stats aggregations in SQL. */
  stats: StatsService;
  /** copilot.yaml (spec 008), or null in scenario mode only. */
  copilot: CopilotConfig | null;
  /** Live connector instances (empty without a copilot config). */
  connectors: ConnectorRegistry;
  /** Graph-run slots shared by POST /incidents and the alert queue (MAX_CONCURRENT_RUNS). */
  runSlots: RunSlots;
  alertQueue: AlertQueue;
  /** POST /ingest/:connectorId: verify, parse, record, enqueue. */
  ingest: IngestService;
  notifications: NotificationService;
  /** The code fixer (spec 009), or null when `codeFix` is absent or disabled. */
  codeFix: CodeFixService | null;
  /** Synchronous: closes the database; connectors close in the background. */
  close(): void;
};

export type ContainerOverrides = {
  clock?: Clock;
  transformScenario?: (s: LoadedScenario) => LoadedScenario;
  logWrite?: (line: string) => void;
  /** Fake provider fixtures; default: fixtures/llm/*.json. */
  fixtures?: FixtureFile[];
  limits?: Partial<Limits>;
  /** Tests only: replaces graph nodes (for example, stopping at the gate to test that node alone). */
  nodes?: Partial<GraphNodes>;
  /** Tests only: a breaker already open or a limiter already full (spec 7.4). */
  guards?: Partial<ExecutionGuards>;
  /** Parsed copilot.yaml (src/index.ts loads it); null or absent means scenario mode only. */
  copilot?: CopilotConfig | null;
  /** The definitions copilot was parsed with; default CONNECTOR_DEFINITIONS and NOTIFIER_DEFINITIONS. */
  connectorDefinitions?: readonly ConnectorDefinition<unknown>[];
  notifierDefinitions?: readonly NotifierDefinition<unknown>[];
  /** Transport of connectors and notifiers; default globalThis.fetch (tests inject a fake). */
  fetch?: typeof fetch;
  /** Wait between notification retries (tests inject an instant one). */
  sleep?: (ms: number) => Promise<void>;
  /** Tests only: the code fixer's ports (workspace, sandbox, code-host reader, self-test, publish hook). */
  codeFixPorts?: CodeFixPorts;
  /** Tests only: replaces code fixer graph nodes. */
  codeFixNodes?: Partial<CodeFixGraphNodes>;
};

/** Ports of the code fixer; each absent one is the real implementation. */
export type CodeFixPorts = {
  workspace?: GitWorkspacePort;
  /** A runner for one attempt directory. */
  sandbox?: (ws: Workspace) => SandboxRunner;
  reader?: CodeHostReader;
  selfTest?: () => Promise<SandboxSelfTestOutcome>;
  publish?: (attemptId: string) => Promise<void>;
};

/** Settings used when there is no copilot config: no connector, so every /ingest call is 404. */
const NO_COPILOT: CopilotConfig = {
  version: 1, mode: "shadow", publicUrl: null, ingest: { ...DEFAULT_INGEST }, services: [], connectors: [], notifiers: [], codeFix: null, secrets: [],
};

/** Simulated clock start before the first alignment (open aligns it to the scenario's detectedAt). */
const SIMULATED_CLOCK_START = new Date("2026-10-04T00:00:00.000Z");

export function createContainer(config: Config, o: ContainerOverrides = {}): Container {
  const copilot = o.copilot ?? null;
  const secrets = collectSecrets(config, copilot?.secrets ?? []);
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
  if (config.llmProvider === "openrouter") {
    const unpriced = missingPrices([config.openrouterModel, config.openrouterModelFallback], modelPrices);
    if (unpriced.length > 0) {
      logger.warn("LLM cost will read as $0.00: no price for the configured model(s) in data/model-prices.json", {
        event: "llm_price_missing", models: unpriced,
      });
    }
  }
  const limits: Limits = { ...DEFAULT_LIMITS, ...o.limits };
  const trace = new TraceSink({ store, ids, clock, secrets });
  const doFetch = o.fetch ?? globalThis.fetch;
  const connectors = createConnectorRegistry({
    definitions: o.connectorDefinitions ?? CONNECTOR_DEFINITIONS,
    entries: copilot?.connectors ?? [],
    fetch: doFetch,
    now: () => clock.now(),
    logger,
  });
  const context = createIncidentContextResolver({
    scenarios,
    live: copilot ? { sources: () => connectors.querySources(), services: copilot.services } : null,
  });

  // Team (task 22).
  const escalation = createEscalationNode({ trace, audit: (e) => store.appendAudit(e) });
  const reporter = createReporterNode({
    llm, providerName: config.llmProvider, trace, clock, context, assumptions,
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
  const execution = { infra, context, guards, trace, clock, persist };
  const nodes: GraphNodes = {
    supervisor: createSupervisorNode({ llm, trace, limits }),
    telemetry_analyst: createTelemetryNode({ llm, tools, context, trace, clock, limits }),
    runbook_retriever: createRunbooksNode({ runbooks, trace }),
    remediation_planner: createPlannerNode({ llm, trace, catalogText: catalogPromptText }),
    auditor: createAuditorNode({ llm, trace, context, limits }),
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
  const notifierDefinitions = o.notifierDefinitions ?? NOTIFIER_DEFINITIONS;
  const notifications = createNotificationService({
    notifiers: (copilot?.notifiers ?? []).map((n) => {
      const def = notifierDefinitions.find((d) => d.type === n.type);
      if (!def) throw new Error(`notifier ${n.id}: type ${n.type} is not registered`);
      return { notifier: def.create(n.config, { id: n.id, http: createHttpClient({ fetch: doFetch }), logger: logger.child({ notifierId: n.id }) }), events: n.events };
    }),
    logger, secrets, publicUrl: copilot?.publicUrl ?? null, clock, ...(o.sleep ? { sleep: o.sleep } : {}),
  });
  // Late-bound: the service is built below and the notification reads its view.
  let incidentsRef: IncidentService | null = null;
  const notificationRead = { view: (x: string) => incidentsRef!.get(x), blackboard: (x: string) => store.loadBlackboard(x).blackboard };
  const codeFix = copilot?.codeFix?.enabled
    ? buildCodeFix({ config, copilot, codeFix: copilot.codeFix, store, ids, clock, logger, trace, llm, secrets, connectors, fetch: doFetch, o, notifications, notificationRead })
    : null;
  const incidents = new IncidentService({
    store, scenarios, graph, clock, ids, limits, runTimeoutMs: config.runTimeoutMs, logger,
    infra: { initialWorld: (s) => infra.initialWorld(s), dryRun: (w, step) => infra.dryRun(w, step) },
    direct: { escalation, reporter },
    trace,
    approvalTtlMin: config.approvalTtlMin,
    live: copilot
      ? {
        dedupeWindowMin: copilot.ingest.dedupeWindowMin,
        secrets,
        notify: (kind, id) => notifications.notify(kind, id, notificationRead),
        ...(codeFix ? { codeFix } : {}),
      }
      : null,
  });
  incidentsRef = incidents;
  const runSlots = createRunSlots(config.maxConcurrentRuns);
  const alertQueue = createAlertQueue({
    slots: runSlots,
    maxQueued: (copilot ?? NO_COPILOT).ingest.maxQueued,
    logger,
    handle: (job) => incidents.handleAlertJob(job.alertId),
  });
  const ingest = createIngestService({ store, registry: connectors, queue: alertQueue, copilot: copilot ?? NO_COPILOT, clock, ids, logger });

  const attempts = new TokenAttemptLimiter();
  const approvals = new ApprovalService({ store, incidents, clock, approvalToken: config.approvalToken, attempts, secrets, logger, codeFix });
  const stats = new StatsService({ db, clock });

  if (codeFix) {
    // Restart recovery first (decision 2), then the sandbox self-test in the background (decision 7).
    codeFix.recover();
    void codeFix.start();
  }

  let closed = false;
  return {
    config, secrets, logger, store, ids, clock, scenarios, runbooks, tools, prices, infra, assumptions, modelPrices, llm, fake, limits, guards, trace, context, incidents, approvals, attempts, stats,
    copilot, connectors, runSlots, alertQueue, ingest, notifications, codeFix,
    close() {
      if (closed) return;
      closed = true;
      codeFix?.close();
      void connectors.close();
      db.close();
    },
  };
}

/**
 * The code fixer (spec 009, decisions 1, 3, 7 and 15): the workspace, the sandbox runner, the GitHub reader, the store,
 * the graph nodes and the service. The GitHub writer is built only in draft_pr mode and only handed to the publisher
 * (decision 3): the fixer graph never sees it, and shadow mode has none at all.
 */
function buildCodeFix(x: {
  config: Config;
  copilot: CopilotConfig;
  codeFix: NonNullable<CopilotConfig["codeFix"]>;
  store: SqliteIncidentStore;
  ids: Ids;
  clock: Clock;
  logger: Logger;
  trace: TraceSink;
  llm: LlmProvider;
  secrets: readonly string[];
  connectors: ConnectorRegistry;
  fetch: typeof fetch;
  o: ContainerOverrides;
  notifications: NotificationService;
  notificationRead: NotificationReadModel;
}): CodeFixService {
  const { codeFix: cfg, o, secrets } = x;
  const ports = o.codeFixPorts ?? {};
  const limits = effectiveLimits(cfg.limits);
  const network = cfg.sandbox.network;
  const fixes = new SqliteCodeFixStore(x.store);
  const logger = x.logger.child({ component: "code_fixer" });
  const git = ports.workspace ?? new GitCliWorkspace({ secrets });
  const sandboxFor = ports.sandbox ?? ((ws: Workspace) => new ProcessSandboxRunner({ attemptDir: ws.root, network, maxOutputBytes: limits.maxOutputBytes, secrets }));
  const reader = ports.reader ?? createGitHubReader(
    { apiUrl: cfg.github.apiUrl, token: cfg.github.token, repositories: cfg.repositories.map((r) => r.repo) },
    { fetch: x.fetch, logger },
  );
  const readTargets = [
    projectPath("copilot.yaml"), projectPath(".env"), projectPath("data"),
    ...(x.config.copilotConfigPath ? [x.config.copilotConfigPath] : []),
    ...(x.config.dbPath !== ":memory:" ? [resolvePath(x.config.dbPath)] : []),
  ];
  const selfTest = ports.selfTest ?? (() => runSandboxSelfTest({ network, readTargets }));
  const redact = (t: string) => redactSecrets(t, secrets);
  let publish = ports.publish;
  if (!publish && cfg.mode === "draft_pr") {
    if (cfg.github.token) {
      const writer = createGitHubWriter(
        { apiUrl: cfg.github.apiUrl, token: cfg.github.token, repositories: cfg.repositories.map((r) => r.repo) },
        { fetch: x.fetch, logger },
      );
      const publisher = new CodeFixPublisher({
        store: x.store, fixes, config: cfg, reader, writer, clock: x.clock, logger, secrets, publicUrl: x.copilot.publicUrl,
      });
      publish = (attemptId) => publisher.publish(attemptId);
    } else {
      // The loader and assertLiveSafe refuse draft_pr without a token; without one nothing could be published.
      logger.warn("code-fix draft_pr mode without a GitHub token: approved fixes are not published", { event: "code_fix_publisher_disabled" });
    }
  }
  const nodeDeps = {
    config: cfg, limits, llm: x.llm, redact, sha256: sha256Hex, now: () => x.clock.now(),
    query: (id: string) => x.connectors.get(id)?.query ?? null,
    serviceAlias: (id: string, service: string) => aliasFor(x.copilot.services, id, service),
    reader, git, sandboxFor,
  };
  return new CodeFixService({
    store: x.store, fixes, config: cfg, limits, clock: x.clock, ids: x.ids, logger, trace: x.trace, secrets,
    connectorFeatures: (id) => {
      const q = x.connectors.get(id)?.query;
      if (!q) return undefined;
      return { errorEvent: typeof q.errorEvent === "function", releaseCommit: typeof q.releaseCommit === "function", deploys: typeof q.deploys === "function" };
    },
    nodesFor: (ctx) => ({ ...createCodeFixNodes(nodeDeps, ctx), ...o.codeFixNodes }),
    selfTest,
    ...(publish ? { publish } : {}),
    // Opt-in notifications (AC-83): the attempt as stored, read only; the service sends nothing when no notifier lists the kind.
    notify: (kind, attemptId) => {
      const attempt = fixes.getAttempt(attemptId);
      if (!attempt) return;
      const approval = attempt.approvalId ? fixes.getApproval(attempt.approvalId) : null;
      return x.notifications.notifyCodeFix(kind, { attempt, approval }, x.notificationRead);
    },
  });
}
