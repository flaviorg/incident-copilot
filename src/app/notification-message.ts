// The outbound notification (spec 008, decision 14): built from the read model only, so a message says exactly what
// the incident view says. Pure. Tiers come from the stored actions (the catalog), never from model text.
import type { Blackboard, IncidentView } from "../contracts/index.ts";
import type { NotificationKind, NotificationMessage } from "../notifiers/types.ts";

const RECOMMENDATION_STATUSES = new Set(["recommended", "blocked_forbidden", "blocked_unknown"]);

export function buildNotificationMessage(i: {
  kind: NotificationKind;
  view: IncidentView;
  blackboard: Pick<Blackboard, "origin">;
  publicUrl: string | null;
  now: Date;
}): NotificationMessage {
  const inc = i.view.incident;
  const origin = i.blackboard.origin;
  const d = i.view.diagnosis;
  return {
    kind: i.kind,
    incidentId: inc.id,
    title: inc.title,
    service: inc.service,
    severity: inc.severity,
    status: inc.status,
    source: { connectorId: origin?.connectorId ?? "", type: origin?.source ?? "scenario", url: origin?.externalUrl ?? null },
    diagnosis: d ? { category: d.category, confidence: d.confidence, hypothesis: d.hypothesis } : null,
    recommendations: [...i.view.actions]
      .filter((a) => RECOMMENDATION_STATUSES.has(a.status) || a.status.startsWith("blocked_"))
      .sort((a, b) => a.order - b.order)
      .map((a) => ({ order: a.order, actionType: a.actionType, target: a.target, tier: a.tier, status: a.status })),
    links: { incident: i.publicUrl ? `${i.publicUrl.replace(/\/+$/, "")}/incidents/${encodeURIComponent(inc.id)}` : null },
    sentAt: i.now.toISOString(),
  };
}
