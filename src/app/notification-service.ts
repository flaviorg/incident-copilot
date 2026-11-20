// Sends notifications to the subscribed notifiers (spec 008, decision 14; AC-56). Never throws and never changes the
// incident: a failure is logged (redacted) and that is all. One retry on a retryable outcome.
import type { Blackboard, IncidentView } from "../contracts/index.ts";
import type { Logger } from "../infra/logger.ts";
import type { Clock } from "../infra/clock.ts";
import { redactSecrets } from "../infra/redact.ts";
import type { Notifier, NotificationKind, NotifyOutcome } from "../notifiers/types.ts";
import { buildNotificationMessage } from "./notification-message.ts";

export type NotificationReadModel = { view(id: string): IncidentView; blackboard(id: string): Pick<Blackboard, "origin"> };

export type NotificationService = {
  notify(kind: NotificationKind, incidentId: string, read: NotificationReadModel): Promise<void>;
};

const MAX_RETRY_WAIT_SEC = 10;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createNotificationService(o: {
  notifiers: readonly { notifier: Notifier; events: readonly NotificationKind[] }[];
  logger: Logger;
  secrets: readonly string[];
  publicUrl: string | null;
  clock?: Pick<Clock, "now">;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): NotificationService {
  const timeoutMs = o.timeoutMs ?? 5000;
  const sleep = o.sleep ?? defaultSleep;
  const now = () => o.clock?.now() ?? new Date();

  const sendOnce = async (n: Notifier, message: Parameters<Notifier["send"]>[0]): Promise<NotifyOutcome> => {
    try {
      return await n.send(message, { signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      return { ok: false, retryable: false, retryAfterSec: null, reason: "notifier threw" };
    }
  };

  return {
    async notify(kind, incidentId, read) {
      const targets = o.notifiers.filter((t) => t.events.includes(kind));
      if (targets.length === 0) return;
      let message;
      try {
        message = redactSecrets(buildNotificationMessage({ kind, view: read.view(incidentId), blackboard: read.blackboard(incidentId), publicUrl: o.publicUrl, now: now() }), o.secrets);
      } catch (e) {
        o.logger.error("notification not built", { event: "notification_failed", kind, incidentId, error: (e as Error)?.name ?? "Error" });
        return;
      }
      for (const { notifier } of targets) {
        let out = await sendOnce(notifier, message);
        if (!out.ok && out.retryable) {
          await sleep(Math.min(out.retryAfterSec ?? 1, MAX_RETRY_WAIT_SEC) * 1000);
          out = await sendOnce(notifier, message);
        }
        if (out.ok) {
          o.logger.info("notification sent", { event: "notification_sent", kind, incidentId, notifierId: notifier.id });
        } else {
          o.logger.warn("notification failed", { event: "notification_failed", kind, incidentId, notifierId: notifier.id, reason: out.reason.slice(0, 200), retryable: out.retryable });
        }
      }
    },
  };
}
