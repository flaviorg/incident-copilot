// The outbound notification (spec 008, decision 14): built from the read model only, so a message says exactly what
// the incident view says. Pure. Tiers come from the stored actions (the catalog), never from model text.
import type { Approval, Blackboard, CodeFixAttempt, IncidentView } from "../contracts/index.ts";
import type { CodeFixNotification, CodeFixNotificationKind, NotificationKind, NotificationMessage } from "../notifiers/types.ts";

const baseUrl = (publicUrl: string) => publicUrl.replace(/\/+$/, "");

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
    links: { incident: i.publicUrl ? `${baseUrl(i.publicUrl)}/incidents/${encodeURIComponent(inc.id)}` : null },
    sentAt: i.now.toISOString(),
  };
}

/** The facts of an attempt for a code-fix message (spec 009, AC-83): counts and names only, never patch or output text. */
export function codeFixFacts(
  a: Pick<CodeFixAttempt, "id" | "status" | "mode" | "repo" | "baseBranch" | "anchor" | "exception" | "files" | "evidence" | "pullRequest">,
  approval: Pick<Approval, "id" | "expiresAt"> | null,
  publicUrl: string | null,
): CodeFixNotification {
  const { reproBefore, fixAfter, suiteAfter } = a.evidence;
  const testName = reproBefore.flatMap((r) => r.failures).find((f) => f.name !== "")?.name ?? null;
  return {
    attemptId: a.id,
    status: a.status,
    mode: a.mode,
    repo: a.repo,
    baseBranch: a.baseBranch,
    location: a.anchor ? { file: a.anchor.file, line: a.anchor.line } : null,
    exceptionType: a.exception?.type ?? null,
    diff: { added: a.files.reduce((n, f) => n + f.added, 0), removed: a.files.reduce((n, f) => n + f.removed, 0), files: a.files.length },
    testName,
    evidence: {
      failedBefore: reproBefore.length > 0 && reproBefore.every((r) => r.failed > 0),
      passesAfter: fixAfter.length > 0 && fixAfter.every((r) => r.outcome === "passed") && (suiteAfter === null || suiteAfter.outcome === "passed"),
      suiteTotal: suiteAfter?.total ?? 0,
      suiteFailed: suiteAfter?.failed ?? 0,
    },
    approval: approval ? { id: approval.id, expiresAt: approval.expiresAt } : null,
    pullRequest: a.pullRequest ? { number: a.pullRequest.number, url: a.pullRequest.url } : null,
    links: {
      approval: approval && publicUrl ? `${baseUrl(publicUrl)}/approvals?status=pending` : null,
      pullRequest: a.pullRequest?.url ?? null,
    },
  };
}

/** A code_fix_ready or code_fix_pr_opened message: the incident's message plus the attempt's facts. Pure. */
export function buildCodeFixNotificationMessage(i: {
  kind: CodeFixNotificationKind;
  view: IncidentView;
  blackboard: Pick<Blackboard, "origin">;
  publicUrl: string | null;
  now: Date;
  attempt: Parameters<typeof codeFixFacts>[0];
  approval: Pick<Approval, "id" | "expiresAt"> | null;
}): NotificationMessage {
  return { ...buildNotificationMessage(i), codeFix: codeFixFacts(i.attempt, i.approval, i.publicUrl) };
}
