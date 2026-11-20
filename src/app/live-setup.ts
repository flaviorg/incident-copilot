// Opening a live incident from an ingested alert (spec 008, decisions 6 and 7): incident row, initial blackboard with
// the origin, the two audit entries, the live_incidents row and the alert outcome, in one transaction. Does not run
// the graph. The scenario path (incident-setup.ts) is untouched.
import type { Blackboard, Incident, IngestedAlertRecord, WorldState } from "../contracts/index.ts";
import type { SqliteIncidentStore } from "../infra/db/incident-store.ts";
import type { Clock } from "../infra/clock.ts";
import type { Ids } from "../infra/ids.ts";
import { clip } from "./trace-sink.ts";

export type LiveSetupDeps = { store: SqliteIncidentStore; clock: Clock; ids: Ids };

/** Sentinel scenario id of a live incident; the fake provider finds its test script by it. */
export const liveScenarioId = (connectorId: string) => `live:${connectorId}`;

const EMPTY_WORLD: WorldState = { deployments: {}, inventory: null, initialInventory: null, notes: [], tagsForReview: [], snapshots: [] };

export function openLiveIncidentRecord(
  d: LiveSetupDeps,
  rec: IngestedAlertRecord,
  ctx: { requestId: string | null },
): { incident: Incident; blackboard: Blackboard; version: number } {
  const a = rec.alert;
  // The simulated clock (tests, demo) moves to the alert time, like a scenario's detectedAt; the system clock ignores it.
  d.clock.alignTo(new Date(a.startedAt));
  return d.store.transaction(() => {
    const id = d.ids.incident();
    const openedAt = d.clock.now().toISOString();
    const title = clip(a.title, 120);
    const incident = d.store.createIncident({
      id, title, service: a.service, severity: a.severity, scenarioId: liveScenarioId(rec.connectorId),
      openedAt, impactStartedAt: a.startedAt, detectedAt: a.startedAt,
    });
    const blackboard: Blackboard = {
      incidentId: id,
      scenarioId: liveScenarioId(rec.connectorId),
      runId: "",
      phase: "new",
      timeOffsetSec: 0,
      alert: {
        title, service: a.service, account: null, signal: a.signal, threshold: null,
        rule: clip(`${a.source}: ${a.title}`, 200), detectedAt: a.startedAt, severity: a.severity,
      },
      diagnosis: null,
      telemetryRuns: 0,
      runbookMatches: [],
      runbookSearchDone: false,
      plan: null,
      planRevision: 0,
      audit: null,
      actions: [],
      world: structuredClone(EMPTY_WORLD),
      verification: null,
      metrics: null,
      postmortem: null,
      supervisor: { iterations: 0, history: [] },
      escalation: null,
      origin: {
        kind: "connector", connectorId: rec.connectorId, source: a.source, fingerprint: a.fingerprint, alertId: rec.id,
        externalUrl: a.url, mode: "shadow",
      },
    };
    const version = d.store.saveBlackboard(id, blackboard, 0);
    d.store.appendAudit({
      incidentId: id, actor: "system:ingest", event: "incident_opened", tier: null,
      details: { source: a.source, connectorId: rec.connectorId, alertId: rec.id, fingerprint: a.fingerprint, requestId: ctx.requestId },
    });
    d.store.appendAudit({
      incidentId: id, actor: "system:ingest", event: "alert_ingested", tier: null,
      details: { alertId: rec.id, externalId: a.externalId, deduplicated: false, requestId: ctx.requestId },
    });
    d.store.openLiveIncident({ incidentId: id, connectorId: rec.connectorId, fingerprint: a.fingerprint, openedAt });
    d.store.updateIngestedAlert(rec.id, { outcome: "opened", incidentId: id });
    return { incident, blackboard, version };
  });
}
