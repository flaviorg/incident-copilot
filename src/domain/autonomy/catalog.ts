// Autonomy Matrix and action catalog (spec 6.4). Pure. The tier comes only from here and from context rules that only raise it;
// the LLM output has no tier field. Tier 4 is forbidden by construction: the forbidden types do not belong to
// ExecutableActionType, so no executor registry typed by it can execute them.
import * as z from "zod";
import type { Tier } from "../../contracts/index.ts";

export type TargetKind = "incident" | "deployment" | "image" | "resource" | "volume" | "ip" | "instance" | "repository";

/** Who proposes a step (spec 009, decision 13). An action with `proposers` is tier 4 for anyone outside the list. */
export type Proposer = "remediation_planner" | "mcp_client" | "code_fixer";

export type ActionSpec = {
  tier: 2 | 3;
  mitigates: boolean;
  reversible: boolean;
  durationSec: number;
  targetKind: TargetKind;
  paramsSchema: z.ZodType<Record<string, unknown>>;
  /** Expected target and parameters as text, for the planner prompt and for the matrix. */
  targetPattern: string;
  paramsText: string;
  description: string;
  /** Absent: any proposer. Present: reserved to these proposers; the others get tier 4 (raise-only rule). */
  proposers?: readonly Proposer[];
};

const text = (max: number) => z.string().trim().min(1).max(max);

export const EXECUTABLE_ACTIONS = {
  add_incident_note: {
    tier: 2, mitigates: false, reversible: false, durationSec: 1, targetKind: "incident",
    paramsSchema: z.strictObject({ text: text(500) }),
    targetPattern: "incident/<incident service or account>", paramsText: "{ text: string }",
    description: "records a note on the ongoing incident",
  },
  block_image_tag: {
    tier: 2, mitigates: false, reversible: true, durationSec: 5, targetKind: "image",
    paramsSchema: z.strictObject({}),
    targetPattern: "image/<service>:<tag>", paramsText: "{}",
    description: "prevents the image tag from being promoted again",
  },
  tag_resource_for_review: {
    tier: 2, mitigates: false, reversible: true, durationSec: 2, targetKind: "resource",
    paramsSchema: z.strictObject({ reason: text(200) }),
    targetPattern: "<volume, ip or instance>/<account>/<id>", paramsText: "{ reason: string }",
    description: "tags the resource for owner review",
  },
  create_volume_snapshot: {
    tier: 2, mitigates: false, reversible: true, durationSec: 30, targetKind: "volume",
    paramsSchema: z.strictObject({}),
    targetPattern: "volume/<account>/<id>", paramsText: "{}",
    description: "creates a snapshot of the volume",
  },
  rollback_deployment: {
    tier: 3, mitigates: true, reversible: true, durationSec: 90, targetKind: "deployment",
    paramsSchema: z.strictObject({ toVersion: text(40) }),
    targetPattern: "deployment/<service>", paramsText: "{ toVersion: string }",
    description: "rolls the deployment back to a version from the deploy history",
  },
  release_elastic_ip: {
    tier: 3, mitigates: true, reversible: false, durationSec: 5, targetKind: "ip",
    paramsSchema: z.strictObject({}),
    targetPattern: "ip/<account>/<id>", paramsText: "{}",
    description: "releases an unassociated public IPv4",
  },
  delete_volume: {
    tier: 3, mitigates: true, reversible: false, durationSec: 20, targetKind: "volume",
    paramsSchema: z.strictObject({}),
    targetPattern: "volume/<account>/<id>", paramsText: "{}",
    description: "deletes an unattached volume",
  },
  resize_instance: {
    tier: 3, mitigates: true, reversible: true, durationSec: 300, targetKind: "instance",
    paramsSchema: z.strictObject({ toType: text(40) }),
    targetPattern: "instance/<account>/<id>", paramsText: "{ toType: string }",
    description: "changes the instance type",
  },
  open_draft_pull_request: {
    tier: 3, mitigates: false, reversible: false, durationSec: 15, targetKind: "repository",
    paramsSchema: z.strictObject({ attemptId: z.string().regex(/^fix_[a-z0-9]{8,40}$/), patchSha256: z.string().regex(/^[0-9a-f]{64}$/) }),
    targetPattern: "repository/<service>", paramsText: "{ attemptId: string, patchSha256: string }",
    description: "opens a draft pull request with the verified patch of a code-fix attempt",
    proposers: ["code_fixer"],
  },
} as const satisfies Record<string, ActionSpec>;

export type ExecutableActionType = keyof typeof EXECUTABLE_ACTIONS;

export const FORBIDDEN_ACTIONS = ["delete_audit_log", "disable_security_scanner", "export_user_data", "run_arbitrary_command", "delete_backups"] as const;
export type ForbiddenActionType = (typeof FORBIDDEN_ACTIONS)[number];

export const EXECUTABLE_ACTION_TYPES = Object.keys(EXECUTABLE_ACTIONS) as ExecutableActionType[];

/** Reasons (fixed text, used in trace and audit). */
export const REASONS = {
  forbidden: "forbidden by construction (tier 4)",
  unknown: "type not in catalog: deny by default",
  outOfScope: "target outside the incident scope",
  noRunbook: "step without a reference runbook",
  unknownRunbook: "runbook reference not among the retrieved runbooks",
  revisionsExhausted: "plan revisions exhausted",
  reservedProposer: "reserved for another proposer (tier 4)",
  catalogTier: (tier: Tier) => `catalog tier: ${tier}`,
} as const;

export function isExecutable(t: string): t is ExecutableActionType {
  return Object.hasOwn(EXECUTABLE_ACTIONS, t);
}

function isForbidden(t: string): t is ForbiddenActionType {
  return (FORBIDDEN_ACTIONS as readonly string[]).includes(t);
}

export function isMitigating(t: string): boolean {
  return isExecutable(t) && EXECUTABLE_ACTIONS[t].mitigates;
}

/** Whether `proposer` may propose `t` at its catalog tier (no `proposers` list means anyone). */
export function allowsProposer(t: ExecutableActionType, proposer: Proposer): boolean {
  const spec: ActionSpec = EXECUTABLE_ACTIONS[t];
  return spec.proposers === undefined || spec.proposers.includes(proposer);
}

/** The planner prompt lists only the actions the planner may propose, so a reserved action never reaches its input. */
export function catalogPromptText(): string {
  return [
    "Executable actions (type: target; parameters; effect; what it does):",
    ...EXECUTABLE_ACTION_TYPES.filter((t) => allowsProposer(t, "remediation_planner")).map((t) => {
      const a = EXECUTABLE_ACTIONS[t];
      return `- ${t}: ${a.targetPattern}; parameters ${a.paramsText}; ${a.mitigates ? "mitigates the incident" : "does not mitigate on its own"}; ${a.description}`;
    }),
    `Forbidden by construction (never executed): ${FORBIDDEN_ACTIONS.join(", ")}.`,
    "Any type not in this list is blocked.",
  ].join("\n");
}

export type ClassificationContext = {
  scope: { service: string | null; account: string | null; incidentId: string };
  revisionsExhausted: boolean;
  /** Refs the runbook retriever actually returned (see runbookRefsOf). A ref outside this set is not evidence. */
  knownRunbookRefs: ReadonlySet<string>;
  /** Who proposes the step; a reserved action outside its `proposers` is raised to tier 4. */
  proposer: Proposer;
};

/**
 * The refs a step may cite: `<runbookId>#<section>` and `<runbookId>` for every retrieved match, lowercased. The
 * runbookRef comes from LLM or MCP text, so it only lowers the "no runbook" raise when it names retrieved evidence.
 */
export function runbookRefsOf(matches: readonly { runbookId: string; section: string }[]): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const m of matches) {
    refs.add(m.runbookId.toLowerCase());
    refs.add(`${m.runbookId}#${m.section}`.toLowerCase());
  }
  return refs;
}
export type Classification = { tier: Tier; reasons: string[]; known: boolean; executable: boolean; paramsOk: boolean; params: Record<string, unknown> | null };

/** incident/<incident id> always; otherwise the target's 2nd segment (before ":") must be the service or the account. */
export function targetInScope(target: string, scope: ClassificationContext["scope"]): boolean {
  const segments = target.split("/");
  if (segments.length < 2) return false;
  if (segments[0] === "incident" && segments[1] === scope.incidentId) return true;
  const owner = segments[1]!.split(":")[0];
  return owner !== "" && (owner === scope.service || owner === scope.account);
}

const raise = (a: Tier, b: Tier): Tier => (b > a ? b : a);

export function classifyAction(
  step: { actionType: string; target: string; params: Record<string, unknown>; runbookRef: string | null },
  ctx: ClassificationContext,
): Classification {
  if (isForbidden(step.actionType)) {
    return { tier: 4, reasons: [REASONS.forbidden], known: true, executable: false, paramsOk: false, params: null };
  }
  if (!isExecutable(step.actionType)) {
    return { tier: 4, reasons: [REASONS.unknown], known: false, executable: false, paramsOk: false, params: null };
  }
  const spec: ActionSpec = EXECUTABLE_ACTIONS[step.actionType];
  let tier: Tier = spec.tier;
  const reasons = [REASONS.catalogTier(spec.tier)];
  if (!allowsProposer(step.actionType, ctx.proposer)) {
    tier = raise(tier, 4);
    reasons.push(REASONS.reservedProposer);
  }
  if (!targetInScope(step.target, ctx.scope)) {
    tier = raise(tier, 3);
    reasons.push(REASONS.outOfScope);
  }
  if (step.runbookRef === null) {
    tier = raise(tier, 3);
    reasons.push(REASONS.noRunbook);
  } else if (!ctx.knownRunbookRefs.has(step.runbookRef.trim().toLowerCase())) {
    tier = raise(tier, 3);
    reasons.push(REASONS.unknownRunbook);
  }
  if (ctx.revisionsExhausted) {
    tier = raise(tier, 3);
    reasons.push(REASONS.revisionsExhausted);
  }
  const parsed = spec.paramsSchema.safeParse(step.params);
  return { tier, reasons, known: true, executable: true, paramsOk: parsed.success, params: parsed.success ? parsed.data : null };
}
