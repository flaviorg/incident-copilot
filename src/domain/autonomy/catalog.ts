// Matriz de Autonomia e catálogo de ações (spec 6.4). Puro. A faixa vem só daqui e de regras de contexto que só sobem;
// a saída do LLM não tem campo de faixa. Faixa 4 é proibida por construção: os tipos proibidos não pertencem a
// ExecutableActionType, então nenhum registro de executores tipado por ele consegue executá-los.
import * as z from "zod";
import type { Tier } from "../../contracts/index.ts";

export type TargetKind = "incident" | "deployment" | "image" | "resource" | "volume" | "ip" | "instance";

export type ActionSpec = {
  tier: 2 | 3;
  mitigates: boolean;
  reversible: boolean;
  durationSec: number;
  targetKind: TargetKind;
  paramsSchema: z.ZodType<Record<string, unknown>>;
  /** Alvo esperado e parâmetros como texto, para o prompt do planejador e para a matriz. */
  targetPattern: string;
  paramsText: string;
  description: string;
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
} as const satisfies Record<string, ActionSpec>;

export type ExecutableActionType = keyof typeof EXECUTABLE_ACTIONS;

export const FORBIDDEN_ACTIONS = ["delete_audit_log", "disable_security_scanner", "export_user_data", "run_arbitrary_command", "delete_backups"] as const;
export type ForbiddenActionType = (typeof FORBIDDEN_ACTIONS)[number];

export const EXECUTABLE_ACTION_TYPES = Object.keys(EXECUTABLE_ACTIONS) as ExecutableActionType[];

/** Motivos (texto fixo, usados em trace e auditoria). */
export const REASONS = {
  forbidden: "forbidden by construction (tier 4)",
  unknown: "type not in catalog: deny by default",
  outOfScope: "target outside the incident scope",
  noRunbook: "step without a reference runbook",
  revisionsExhausted: "plan revisions exhausted",
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

export function catalogPromptText(): string {
  return [
    "Executable actions (type: target; parameters; effect; what it does):",
    ...EXECUTABLE_ACTION_TYPES.map((t) => {
      const a = EXECUTABLE_ACTIONS[t];
      return `- ${t}: ${a.targetPattern}; parameters ${a.paramsText}; ${a.mitigates ? "mitigates the incident" : "does not mitigate on its own"}; ${a.description}`;
    }),
    `Forbidden by construction (never executed): ${FORBIDDEN_ACTIONS.join(", ")}.`,
    "Any type not in this list is blocked.",
  ].join("\n");
}

export type ClassificationContext = { scope: { service: string | null; account: string | null; incidentId: string }; revisionsExhausted: boolean };
export type Classification = { tier: Tier; reasons: string[]; known: boolean; executable: boolean; paramsOk: boolean; params: Record<string, unknown> | null };

/** incident/<id do incidente> sempre; senão o 2º segmento do alvo (antes de ":") precisa ser o serviço ou a conta. */
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
  if (!targetInScope(step.target, ctx.scope)) {
    tier = raise(tier, 3);
    reasons.push(REASONS.outOfScope);
  }
  if (step.runbookRef === null) {
    tier = raise(tier, 3);
    reasons.push(REASONS.noRunbook);
  }
  if (ctx.revisionsExhausted) {
    tier = raise(tier, 3);
    reasons.push(REASONS.revisionsExhausted);
  }
  const parsed = spec.paramsSchema.safeParse(step.params);
  return { tier, reasons, known: true, executable: true, paramsOk: parsed.success, params: parsed.success ? parsed.data : null };
}
