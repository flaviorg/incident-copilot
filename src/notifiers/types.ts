// Notifier port (spec 008, decision 14): outbound messages to the team's chat or any webhook. Notifications never
// decide: a failed send is logged and never changes the incident.
import type * as z from "zod";
import type { IncidentStatus, Severity } from "../contracts/index.ts";
import type { Logger } from "../infra/logger.ts";
import type { ConfigHelpers } from "../connectors/shared/config-helpers.ts";
import type { HttpClient } from "../connectors/shared/http.ts";

export type NotificationKind =
  | "incident_opened" | "analysis_ready" | "run_failed" | "incident_resolved"
  | "code_fix_ready" | "code_fix_pr_opened";
export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  "incident_opened", "analysis_ready", "run_failed", "incident_resolved", "code_fix_ready", "code_fix_pr_opened",
];
/** The `events` of a notifier entry that lists none: the four 0.4 kinds. The code-fix kinds are opt-in (spec 009, AC-83). */
export const DEFAULT_NOTIFICATION_EVENTS: readonly NotificationKind[] = ["incident_opened", "analysis_ready", "run_failed", "incident_resolved"];

export type CodeFixNotificationKind = Extract<NotificationKind, "code_fix_ready" | "code_fix_pr_opened">;

/**
 * The code-fix facts of a `code_fix_*` message (spec 009, AC-83), built from the stored attempt only: counts, the
 * anchor, the regression test name and booleans over the test runs. Never the patch, a post-image or test output text.
 */
export type CodeFixNotification = {
  attemptId: string;
  /** patch_ready (shadow), awaiting_approval (draft_pr) or pr_opened. */
  status: string;
  mode: "shadow" | "draft_pr";
  repo: string;
  baseBranch: string;
  location: { file: string; line: number } | null;
  exceptionType: string | null;
  diff: { added: number; removed: number; files: number };
  testName: string | null;
  /** failedBefore: every reproduction run failed; passesAfter: every fix run passed and the suite passed. */
  evidence: { failedBefore: boolean; passesAfter: boolean; suiteTotal: number; suiteFailed: number };
  approval: { id: string; expiresAt: string } | null;
  pullRequest: { number: number; url: string } | null;
  links: { approval: string | null; pullRequest: string | null };
};

export type NotificationMessage = {
  kind: NotificationKind;
  incidentId: string;
  title: string;
  service: string | null;
  severity: Severity;
  status: IncidentStatus;
  source: { connectorId: string; type: string; url: string | null };
  diagnosis: { category: string; confidence: string; hypothesis: string } | null;
  /** Catalog tiers, never the model's: recommended and blocked steps of the plan. */
  recommendations: { order: number; actionType: string; target: string; tier: 1 | 2 | 3 | 4; status: string }[];
  links: { incident: string | null }; // from publicUrl
  sentAt: string;
  /** Present only on code_fix_ready and code_fix_pr_opened. */
  codeFix?: CodeFixNotification;
};

export type NotifyOutcome = { ok: true } | { ok: false; retryable: boolean; retryAfterSec: number | null; reason: string };

export interface NotifierDefinition<C> {
  /** "slack"; also the name of the setup guide docs/connectors/<type>.md. Unique across connectors and notifiers. */
  readonly type: string;
  /** The notifier entry without id, type and events. */
  configSchema(h: ConfigHelpers): z.ZodType<C>;
  create(config: C, deps: { id: string; http: HttpClient; logger: Logger }): Notifier;
}

export interface Notifier {
  readonly id: string;
  readonly type: string;
  /** Never throws; `reason` is a fixed short text (no body, header or URL). Honors `signal`. */
  send(m: NotificationMessage, io: { signal: AbortSignal }): Promise<NotifyOutcome>;
}

export function defineNotifier<C>(d: NotifierDefinition<C>): NotifierDefinition<unknown> {
  return d as unknown as NotifierDefinition<unknown>;
}
