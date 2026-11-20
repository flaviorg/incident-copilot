// Live ingest persistence (spec 008, decision 8): idempotency on (connectorId, externalId), outcomes and live incidents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../src/infra/db/sqlite.ts";
import { SqliteIncidentStore } from "../../src/infra/db/incident-store.ts";
import { DbIds } from "../../src/infra/ids.ts";
import type { NormalizedAlert } from "../../src/contracts/index.ts";

const SECRET = "webhook-secret-" + "z".repeat(20);
const mk = () => new SqliteIncidentStore(openDatabase(":memory:"), { secrets: [SECRET], now: () => new Date("2026-10-04T10:00:00Z") });
const alert = (over: Partial<NormalizedAlert> = {}): NormalizedAlert => ({
  source: "alertmanager", externalId: "fp1:2026-10-04T09:40:00.000Z:firing", fingerprint: "fp1", service: "checkout", title: "High error rate",
  severity: "sev2", status: "firing", startedAt: "2026-10-04T09:40:00.000Z", url: null, signal: "other", attributes: { alertname: "HighErrorRate" }, ...over,
});

test("recordIngestedAlert is idempotent and allocates ids only for new rows", () => {
  const s = mk();
  const ids = new DbIds(s);
  const a = s.recordIngestedAlert({ connectorId: "prom", alert: alert(), receivedAt: "2026-10-04T10:00:00.000Z", requestId: "req-1" }, () => ids.alert());
  assert.deepEqual(a, { inserted: true, id: "ALR-0001" });
  const dup = s.recordIngestedAlert({ connectorId: "prom", alert: alert({ title: "changed" }), receivedAt: "2026-10-04T10:01:00.000Z", requestId: "req-2" }, () => ids.alert());
  assert.deepEqual(dup, { inserted: false, id: "ALR-0001" });
  // Same externalId on another connector is a different event.
  assert.equal(s.recordIngestedAlert({ connectorId: "other", alert: alert(), receivedAt: "2026-10-04T10:02:00.000Z", requestId: null }).id, "ALR-0002");
  const rec = s.getIngestedAlert("ALR-0001")!;
  assert.deepEqual([rec.connectorId, rec.outcome, rec.incidentId, rec.detail, rec.requestId, rec.alert.title], ["prom", "queued", null, null, "req-1", "High error rate"]);
  assert.equal(s.getIngestedAlert("ALR-9999"), null);
});

test("stored alert text and details are redacted; outcome updates keep missing fields", () => {
  const s = mk();
  const { id } = s.recordIngestedAlert({ connectorId: "prom", alert: alert({ title: `leak ${SECRET}` }), receivedAt: "2026-10-04T10:00:00.000Z", requestId: null });
  assert.doesNotMatch(JSON.stringify(s.getIngestedAlert(id)), new RegExp(SECRET));
  s.updateIngestedAlert(id, { outcome: "opened", incidentId: "INC-0001" });
  s.updateIngestedAlert(id, { outcome: "failed", detail: `boom ${SECRET} ${"x".repeat(400)}` });
  const rec = s.getIngestedAlert(id)!;
  assert.equal(rec.outcome, "failed");
  assert.equal(rec.incidentId, "INC-0001");
  assert.ok(rec.detail!.length <= 300);
  assert.doesNotMatch(rec.detail!, new RegExp(SECRET));
  assert.throws(() => s.updateIngestedAlert("ALR-9999", { outcome: "ignored" }), /not found/);
});

test("listIngestedAlerts newest first with a connector filter; listQueuedAlerts oldest first", () => {
  const s = mk();
  for (let i = 1; i <= 3; i++) {
    s.recordIngestedAlert({ connectorId: i === 2 ? "sentry" : "prom", alert: alert({ externalId: `e${i}` }), receivedAt: `2026-10-04T10:0${i}:00.000Z`, requestId: null });
  }
  assert.deepEqual(s.listIngestedAlerts({ limit: 10 }).map((r) => r.alert.externalId), ["e3", "e2", "e1"]);
  assert.deepEqual(s.listIngestedAlerts({ limit: 1 }).map((r) => r.alert.externalId), ["e3"]);
  assert.deepEqual(s.listIngestedAlerts({ limit: 10, connectorId: "prom" }).map((r) => r.alert.externalId), ["e3", "e1"]);
  s.updateIngestedAlert("ALR-0001", { outcome: "opened" });
  assert.deepEqual(s.listQueuedAlerts().map((r) => r.id), ["ALR-0002", "ALR-0003"]);
});

test("live incidents: one open row per fingerprint, closed rows free the slot; setIncidentResolved", () => {
  const s = mk();
  const base = { title: "t", service: "checkout-api", severity: "sev2" as const, openedAt: "2026-10-04T10:00:00.000Z", impactStartedAt: "2026-10-04T09:40:00.000Z", detectedAt: "2026-10-04T09:40:00.000Z" };
  s.createIncident({ ...base, id: "INC-0001", scenarioId: "live:prom" });
  s.createIncident({ ...base, id: "INC-0002", scenarioId: "live:prom" });
  assert.equal(s.findOpenLiveIncident("prom", "fp1"), null);
  s.openLiveIncident({ incidentId: "INC-0001", connectorId: "prom", fingerprint: "fp1", openedAt: "2026-10-04T10:00:00.000Z" });
  assert.deepEqual(s.findOpenLiveIncident("prom", "fp1"), { incidentId: "INC-0001", openedAt: "2026-10-04T10:00:00.000Z" });
  assert.throws(() => s.openLiveIncident({ incidentId: "INC-0002", connectorId: "prom", fingerprint: "fp1", openedAt: "2026-10-04T10:05:00.000Z" }), /UNIQUE/);
  s.closeLiveIncident("INC-0001", "2026-10-04T10:10:00.000Z");
  assert.equal(s.findOpenLiveIncident("prom", "fp1"), null);
  s.openLiveIncident({ incidentId: "INC-0002", connectorId: "prom", fingerprint: "fp1", openedAt: "2026-10-04T10:15:00.000Z" });
  assert.equal(s.findOpenLiveIncident("prom", "fp1")!.incidentId, "INC-0002");

  s.updateIncidentStatus("INC-0001", "escalated", { escalation: { reason: "llm_unavailable", detail: "d" } });
  s.setIncidentResolved("INC-0001", "2026-10-04T10:10:00.000Z");
  const inc = s.getIncident("INC-0001")!;
  assert.deepEqual([inc.status, inc.resolvedAt, inc.escalation?.reason], ["resolved", "2026-10-04T10:10:00.000Z", "llm_unavailable"]);
  assert.throws(() => s.setIncidentResolved("INC-9999", "2026-10-04T10:10:00.000Z"), /not found/);
});
