// Sends notifications to the subscribed notifiers (spec 008, decision 14; AC-56). Never throws and never changes the
// incident: a failure is logged (redacted) and that is all. One retry on a retryable outcome. Code-fix messages
// (spec 009, AC-83) take the same path and never change the attempt.
import type { Approval, Blackboard, CodeFixAttempt, IncidentView } from "../contracts/index.ts";
import type { Logger } from "../infra/logger.ts";
import type { Clock } from "../infra/clock.ts";
import { redactSecrets } from "../infra/redact.ts";
import type { CodeFixNotificationKind, Notifier, NotificationKind, NotificationMessage, NotifyOutcome } from "../notifiers/types.ts";
import { buildCodeFixNotificationMessage, buildNotificationMessage } from "./notification-message.ts";

export type NotificationReadModel = { view(id: string): IncidentView; blackboard(id: string): Pick<Blackboard, "origin"> };

export type NotificationService = {
  notify(kind: NotificationKind, incidentId: string, read: NotificationReadModel): Promise<void>;
  /** A code_fix_ready or code_fix_pr_opened message about one attempt. Never throws; reads the attempt only. */
  notifyCodeFix(kind: CodeFixNotificationKind, fix: CodeFixNotificationInput, read: NotificationReadModel): Promise<void>;
};

export type CodeFixNotificationInput = {
  attempt: CodeFixAttempt;
  approval: Pick<Approval, "id" | "expiresAt"> | null;
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

  const deliver = async (kind: NotificationKind, incidentId: string, build: () => NotificationMessage): Promise<void> => {
    const targets = o.notifiers.filter((t) => t.events.includes(kind));
    if (targets.length === 0) return;
    let message: NotificationMessage;
    try {
      message = redactSecrets(build(), o.secrets);
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
  };

  return {
    async notify(kind, incidentId, read) {
      await deliver(kind, incidentId, () =>
        buildNotificationMessage({ kind, view: read.view(incidentId), blackboard: read.blackboard(incidentId), publicUrl: o.publicUrl, now: now() }));
    },
    async notifyCodeFix(kind, fix, read) {
      try {
        const incidentId = fix.attempt.incidentId;
        await deliver(kind, incidentId, () => buildCodeFixNotificationMessage({
          kind, view: read.view(incidentId), blackboard: read.blackboard(incidentId), publicUrl: o.publicUrl, now: now(),
          attempt: fix.attempt, approval: fix.approval,
        }));
      } catch (e) {
        o.logger.error("code-fix notification failed", { event: "notification_failed", kind, error: (e as Error)?.name ?? "Error" });
      }
    },
  };
}
