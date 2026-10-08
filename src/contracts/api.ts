// Contratos da borda HTTP e MCP (spec 5.3 e 5.4).
import * as z from "zod";
import {
  ActionStatusSchema, AgentIdSchema, ApprovalStatusSchema, EscalationReasonSchema,
  IncidentStatusSchema, SeveritySchema, TierSchema, TraceTypeSchema,
} from "./enums.ts";
import { IncidentSchema } from "./incident.ts";
import { DiagnosisSchema } from "./diagnosis.ts";
import { RemediationPlanSchema } from "./plan.ts";
import { AuditEventSchema, AuditReviewSchema } from "./audit.ts";
import { DryRunResultSchema, GatedActionSchema } from "./actions.ts";
import { ApprovalSchema } from "./approval.ts";
import { RunbookMatchSchema, VerificationSchema } from "./blackboard.ts";
import { IncidentMetricsSchema } from "./metrics.ts";

// Entradas
export const CreateIncidentBodySchema = z.object({
  scenarioId: z.string().min(1).max(64),
  title: z.string().min(1).max(120).optional(),
});

export const ListIncidentsQuerySchema = z.object({
  status: IncidentStatusSchema.optional(),
  service: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const TraceQuerySchema = z.object({
  type: TraceTypeSchema.optional(),
  agent: AgentIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const PostmortemQuerySchema = z.object({ format: z.enum(["md", "json"]).default("md") });

export const ApprovalsQuerySchema = z.object({ status: ApprovalStatusSchema.default("pending") });

export const DecisionBodySchema = z
  .object({
    decision: z.enum(["approve", "reject"]).optional(),
    text: z.string().max(40).optional(),
    approver: z.string().trim().min(1).max(60),
    comment: z.string().max(500).optional(),
  })
  .refine((b) => (b.decision === undefined) !== (b.text === undefined), {
    message: "informe exatamente um entre decision e text",
    path: ["decision"],
  });

export const StatsWindowSchema = z.enum(["1h", "24h", "7d"]);
export const StatsQuerySchema = z.object({ since: StatsWindowSchema.default("24h") });

// Saídas
export const IncidentSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  service: z.string().nullable(),
  severity: SeveritySchema,
  status: IncidentStatusSchema,
  scenarioId: z.string(),
  openedAt: z.string(),
  resolvedAt: z.string().nullable(),
  escalationReason: EscalationReasonSchema.nullable(),
  mttrMin: z.number().nullable(),
});

export const IncidentViewSchema = z.object({
  incident: IncidentSchema,
  diagnosis: DiagnosisSchema.nullable(),
  runbookMatches: z.array(RunbookMatchSchema),
  plan: RemediationPlanSchema.nullable(),
  planRevision: z.number().int(),
  audit: AuditReviewSchema.nullable(),
  actions: z.array(GatedActionSchema),
  approvals: z.array(ApprovalSchema), // status efetivo
  verification: VerificationSchema.nullable(),
  metrics: IncidentMetricsSchema.nullable(),
  postmortemReady: z.boolean(),
  traceCount: z.number().int().nonnegative(),
});

export const AuditEntryViewSchema = z.object({
  id: z.string(),
  ts: z.string(),
  actor: z.string(),
  event: AuditEventSchema,
  tier: TierSchema.nullable(),
  details: z.record(z.string(), z.unknown()),
  // Com prevHash, o cliente recalcula cada hash (incidentId vem da URL) e confere o encadeamento.
  prevHash: z.string(),
  hash: z.string(),
});

const count = z.number().int().nonnegative();

export const StatsSchema = z.object({
  window: StatsWindowSchema,
  incidents: z.object({ total: count, byStatus: z.record(IncidentStatusSchema, count) }),
  mttrMin: z.object({ p50: z.number().nullable(), p95: z.number().nullable() }),
  actions: z.object({
    byTier: z.object({ "1": count, "2": count, "3": count, "4": count }),
    byStatus: z.record(ActionStatusSchema, count),
  }),
  approvals: z.object({ pending: count, approved: count, rejected: count, expired: count }),
  guard: z.object({ supervisorCoercions: count, auditorOverrides: count, numericGuardRejections: count }),
  llm: z.object({ calls: count, errors: count, promptTokens: count, completionTokens: count, estimatedCostUsd: z.number().nonnegative() }),
});

export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});

// MCP: propose_remediation. O cliente MCP não se autentica, então todo campo livre tem teto: um alvo ou parâmetro
// gigante seria classificado, iria para a fila do humano e entraria inteiro no trace e no blackboard.
/** Teto do JSON de `params`: o maior parâmetro do catálogo (a nota, 500 caracteres) com folga. */
export const MCP_PARAMS_MAX_JSON_CHARS = 2000;

const jsonLength = (v: unknown): number => {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

export const ProposeRemediationInputSchema = z.object({
  incidentId: z.string().min(1).max(64),
  actionType: z.string().min(1).max(64),
  target: z.string().min(1).max(200),
  params: z.record(z.string(), z.unknown()).refine((p) => jsonLength(p) <= MCP_PARAMS_MAX_JSON_CHARS, {
    message: `params passa de ${MCP_PARAMS_MAX_JSON_CHARS} caracteres em JSON`,
  }),
  rationale: z.string().max(300),
  runbookRef: z.string().min(1).max(120).optional(),
});

export const ProposeRemediationResultSchema = z.object({
  actionId: z.string(),
  tier: TierSchema,
  status: ActionStatusSchema,
  classificationReasons: z.array(z.string()),
  dryRun: DryRunResultSchema.nullable(),
  approvalId: z.string().nullable(),
});
