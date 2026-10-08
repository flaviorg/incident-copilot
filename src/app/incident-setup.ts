// Abertura do registro de um incidente (spec 5.1, passo 1 e 7.5): alinha o relógio ao alerta, calcula o deslocamento,
// grava incidente, blackboard inicial (phase "new") e auditoria incident_opened numa transação. Não executa o grafo.
// Usado pelo IncidentService.open, pela CLI `diagnose` e pelos testes de nós isolados.
import type { Blackboard, Incident, WorldState } from "../contracts/index.ts";
import type { SqliteIncidentStore } from "../infra/db/incident-store.ts";
import type { ScenarioRepository, LoadedScenario } from "../infra/scenarios/scenario-loader.ts";
import type { Clock } from "../infra/clock.ts";
import type { Ids } from "../infra/ids.ts";
import { impactStartOf } from "../domain/metrics/incident-metrics.ts";

export type IncidentSetupDeps = {
  store: SqliteIncidentStore;
  scenarios: ScenarioRepository;
  clock: Clock;
  ids: Ids;
  initialWorld: (s: LoadedScenario) => WorldState;
};

function initialBlackboardFor(incidentId: string, scenario: LoadedScenario, world: WorldState): Blackboard {
  return {
    incidentId,
    scenarioId: scenario.id,
    runId: "", // cada invocação do grafo recebe o seu (IncidentService.run)
    phase: "new",
    timeOffsetSec: scenario.offsetSec,
    alert: scenario.alert,
    diagnosis: null,
    telemetryRuns: 0,
    runbookMatches: [],
    runbookSearchDone: false,
    plan: null,
    planRevision: 0,
    audit: null,
    actions: [],
    world,
    verification: null,
    metrics: null,
    postmortem: null,
    supervisor: { iterations: 0, history: [] },
    escalation: null,
  };
}

export function openIncidentRecord(
  d: IncidentSetupDeps,
  i: { scenarioId: string; title?: string },
  ctx: { requestId: string | null },
): { incident: Incident; blackboard: Blackboard; version: number } {
  const base = d.scenarios.get(i.scenarioId); // NotFoundError("scenario_not_found") se não existir
  const detected = new Date(base.alert.detectedAt);
  const aligned = d.clock.alignTo(detected);
  const offsetSec = Math.round((aligned.getTime() - detected.getTime()) / 1000);
  const scenario = d.scenarios.get(i.scenarioId, { offsetSec });
  return d.store.transaction(() => {
    const id = d.ids.incident();
    const incident = d.store.createIncident({
      id,
      title: i.title ?? scenario.file.title,
      service: scenario.file.service,
      severity: scenario.file.severity,
      scenarioId: scenario.id,
      openedAt: d.clock.now().toISOString(),
      impactStartedAt: impactStartOf(scenario.alert, scenario.series),
      detectedAt: scenario.alert.detectedAt,
    });
    const blackboard = initialBlackboardFor(id, scenario, d.initialWorld(scenario));
    const version = d.store.saveBlackboard(id, blackboard, 0);
    d.store.appendAudit({
      incidentId: id,
      actor: "system:incident-service",
      event: "incident_opened",
      tier: null,
      details: { scenarioId: scenario.id, title: incident.title, requestId: ctx.requestId },
    });
    return { incident, blackboard, version };
  });
}
