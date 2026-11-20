// A complete NotificationMessage for notifier tests.
import type { NotificationMessage } from "../../src/notifiers/types.ts";

export function sampleNotificationMessage(overrides: Partial<NotificationMessage> = {}): NotificationMessage {
  return {
    kind: "analysis_ready",
    incidentId: "INC-0001",
    title: "High error rate in checkout <script>&",
    service: "checkout-api",
    severity: "sev2",
    status: "advised",
    source: { connectorId: "prom", type: "alertmanager", url: "https://prometheus.example.com/graph?g0.expr=up" },
    diagnosis: { category: "bad_deploy", confidence: "high", hypothesis: "The v2.4.0 deploy introduced a TypeError in PriceFormatter" },
    recommendations: [
      { order: 1, actionType: "rollback_deployment", target: "deployment/checkout-api", tier: 3, status: "recommended" },
      { order: 2, actionType: "add_incident_note", target: "incident/checkout-api", tier: 2, status: "recommended" },
      { order: 3, actionType: "run_arbitrary_command", target: "host/checkout-api", tier: 4, status: "blocked_forbidden" },
    ],
    links: { incident: "https://copilot.example.com/incidents/INC-0001" },
    sentAt: "2026-10-04T10:05:00.000Z",
    ...overrides,
  };
}
