// Notifications (spec 008, decision 14; AC-56): built from the read model with catalog tiers, redacted, sent to the
// subscribed notifiers with one retry, never throwing. Also proves the notifier conformance kit on a tiny HTTP notifier.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import { buildNotificationMessage } from "../../src/app/notification-message.ts";
import { createNotificationService } from "../../src/app/notification-service.ts";
import { createIncidentContextResolver } from "../../src/app/incident-context.ts";
import { defineNotifier } from "../../src/notifiers/types.ts";
import type { Notifier, NotificationMessage, NotifyOutcome } from "../../src/notifiers/types.ts";
import { ConnectorError } from "../../src/connectors/shared/errors.ts";
import { createLogger } from "../../src/infra/logger.ts";
import type { IncidentView } from "../../src/contracts/index.ts";
import { act } from "../helpers/blackboard.ts";
import { describeNotifierConformance } from "../helpers/notifier-conformance.ts";

const SECRET = "notify-secret-" + "n".repeat(20);
const origin = { kind: "connector" as const, connectorId: "prom", source: "alertmanager", fingerprint: "fp", alertId: "ALR-0001", externalUrl: "https://prom.example.com/x", mode: "shadow" as const };

function view(over: Partial<IncidentView["incident"]> = {}): IncidentView {
  return {
    incident: {
      id: "INC-0001", title: `High error rate ${SECRET}`, service: "checkout-api", severity: "sev1", status: "advised", scenarioId: "live:prom",
      openedAt: "2026-10-04T09:41:30.000Z", impactStartedAt: "2026-10-04T09:41:30.000Z", detectedAt: "2026-10-04T09:41:30.000Z", resolvedAt: null, escalation: null, ...over,
    },
    diagnosis: { hypothesis: "bad deploy", category: "bad_deploy", confidence: "high", evidence: [{ source: "errors", ref: "errors:x", summary: "s" }], capReached: false },
    runbookMatches: [], plan: null, planRevision: 0, audit: null,
    actions: [
      act("blocked_forbidden", { id: "ACT-0003", order: 3, actionType: "run_arbitrary_command", tier: 4 }),
      act("recommended", { id: "ACT-0001", order: 1, tier: 3 }),
      act("recommended", { id: "ACT-0002", order: 2, actionType: "add_incident_note", target: "incident/checkout-api", tier: 2 }),
      act("rejected_invalid_params", { id: "ACT-0004", order: 4, tier: 2 }),
    ],
    approvals: [], verification: null, metrics: null, postmortemReady: true, traceCount: 10,
  };
}

test("buildNotificationMessage takes the recommendations and their tiers from the stored actions", () => {
  const m = buildNotificationMessage({ kind: "analysis_ready", view: view(), blackboard: { origin }, publicUrl: "https://copilot.example.com/", now: new Date("2026-10-04T10:00:00Z") });
  assert.deepEqual(m.recommendations.map((r) => [r.order, r.actionType, r.tier, r.status]), [
    [1, "rollback_deployment", 3, "recommended"], [2, "add_incident_note", 2, "recommended"], [3, "run_arbitrary_command", 4, "blocked_forbidden"],
  ]);
  assert.deepEqual(m.source, { connectorId: "prom", type: "alertmanager", url: "https://prom.example.com/x" });
  assert.equal(m.links.incident, "https://copilot.example.com/incidents/INC-0001");
  assert.deepEqual(m.diagnosis, { category: "bad_deploy", confidence: "high", hypothesis: "bad deploy" });
  assert.equal(m.sentAt, "2026-10-04T10:00:00.000Z");
  assert.equal(buildNotificationMessage({ kind: "incident_opened", view: view(), blackboard: { origin }, publicUrl: null, now: new Date() }).links.incident, null);
});

function recorder(outcomes: NotifyOutcome[] = []): { notifier: Notifier; sent: NotificationMessage[] } {
  const sent: NotificationMessage[] = [];
  return { sent, notifier: { id: "n", type: "rec", send: async (m) => { sent.push(m); return outcomes.shift() ?? { ok: true }; } } };
}
const read = { view: () => view(), blackboard: () => ({ origin }) };

test("only subscribed notifiers receive the kind; the message is redacted", async () => {
  const a = recorder();
  const b = recorder();
  const lines: string[] = [];
  const svc = createNotificationService({
    notifiers: [{ notifier: a.notifier, events: ["analysis_ready"] }, { notifier: b.notifier, events: ["incident_resolved"] }],
    logger: createLogger({ level: "debug", secrets: [SECRET], write: (l) => void lines.push(l) }), secrets: [SECRET], publicUrl: null,
  });
  await svc.notify("analysis_ready", "INC-0001", read);
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 0);
  assert.ok(!JSON.stringify(a.sent).includes(SECRET));
  assert.match(a.sent[0]!.title, /\[REDACTED\]/);
  assert.ok(lines.some((l) => l.includes("notification_sent")));
});

test("one retry on a retryable outcome with a capped wait; a permanent failure is logged; nothing throws", async () => {
  const waits: number[] = [];
  const flaky = recorder([{ ok: false, retryable: true, retryAfterSec: 60, reason: "rate limited" }, { ok: true }]);
  const broken = recorder([{ ok: false, retryable: true, retryAfterSec: null, reason: "unavailable" }, { ok: false, retryable: true, retryAfterSec: null, reason: "unavailable" }]);
  const throwing: Notifier = { id: "t", type: "x", send: async () => { throw new ConnectorError("unavailable"); } };
  const lines: string[] = [];
  const svc = createNotificationService({
    notifiers: [{ notifier: flaky.notifier, events: ["run_failed"] }, { notifier: broken.notifier, events: ["run_failed"] }, { notifier: throwing, events: ["run_failed"] }],
    logger: createLogger({ level: "debug", secrets: [], write: (l) => void lines.push(l) }), secrets: [], publicUrl: null,
    sleep: async (ms) => void waits.push(ms),
  });
  await svc.notify("run_failed", "INC-0001", read);
  assert.equal(flaky.sent.length, 2);
  assert.equal(broken.sent.length, 2, "only one retry");
  assert.deepEqual(waits, [10_000, 1000]);
  assert.equal(lines.filter((l) => l.includes("notification_failed")).length, 2);
  await svc.notify("run_failed", "INC-404", { view: () => { throw new Error("not found"); }, blackboard: () => ({ origin }) });
});

test("the context resolver keeps the scenario call and refuses a live incident without configuration", () => {
  const calls: unknown[] = [];
  const scenarios = { get: (id: string, o?: { offsetSec?: number }) => { calls.push([id, o]); return { id } as never; } };
  const r = createIncidentContextResolver({ scenarios, live: null });
  assert.deepEqual(r.resolve({ scenarioId: "deploy-5xx-rollback", timeOffsetSec: 42 }), { kind: "scenario", scenario: { id: "deploy-5xx-rollback" } });
  assert.deepEqual(calls, [["deploy-5xx-rollback", { offsetSec: 42 }]]);
  assert.throws(() => r.resolve({ scenarioId: "live:prom", timeOffsetSec: 0, origin }), /live incident without connector configuration/);
  const live = createIncidentContextResolver({ scenarios, live: { sources: () => [], services: [{ name: "checkout-api", aliases: {} }] } });
  const ctx = live.resolve({ scenarioId: "live:prom", timeOffsetSec: 0, origin, alert: { title: "t", service: "checkout-api", account: null, signal: "other", threshold: null, rule: "r", detectedAt: "2026-10-04T09:41:30.000Z", severity: "sev1" } });
  assert.ok(ctx.kind === "live" && ctx.incidentService === "checkout-api" && ctx.origin.connectorId === "prom");
});

// Proves the notifier kit before the real notifiers use it.
const HOOK = "https://hooks.example.com/services/" + "h".repeat(24);
const echo = defineNotifier({
  type: "echo-webhook",
  configSchema: (h) => z.strictObject({ url: h.secret() }),
  create: (c, d) => ({
    id: d.id, type: "echo-webhook",
    async send(m, io) {
      try {
        await d.http.json({ method: "POST", url: c.url, body: JSON.stringify({ text: m.title }), headers: { "content-type": "application/json" }, signal: io.signal });
        return { ok: true };
      } catch (e) {
        const kind = e instanceof ConnectorError ? e.kind : "unavailable";
        return { ok: false, retryable: kind === "rate_limited" || kind === "unavailable" || kind === "timeout", retryAfterSec: e instanceof ConnectorError ? e.retryAfterSec : null, reason: kind };
      }
    },
  }),
});
describeNotifierConformance(echo, {
  env: { ECHO_URL: HOOK },
  entry: { url: "${ECHO_URL}", events: ["analysis_ready"] },
  secrets: [HOOK],
  okRoutes: [{ method: "POST", url: HOOK, body: { ok: true } }],
  failureRoutes: (kind) => [{ method: "POST", url: HOOK, status: kind === "retryable" ? 503 : 400 }],
});
