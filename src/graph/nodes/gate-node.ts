// Portão de remediação (spec 4.6, 5.1 passo 8, 6.4 e AC-10 a AC-12). Sem LLM: classifica cada passo pelo catálogo,
// valida parâmetros e roda o dry run em sequência sobre um mundo hipotético que acumula o efeito dos passos aceitos.
// Faixa 4 ou tipo desconhecido é bloqueado sem dry run; faixa 2 com dry run ok fica pronta; faixa 3 com dry run ok
// pede aprovação humana. Nada executa aqui. As decisões do lote saem juntas no fim (um dry run leva 2 s simulados),
// então os pedidos de aprovação têm o instante em que o portão entrega o lote ao humano.
import type { Approval, AuditEntry, AuditEvent, GatedAction, PlanStep } from "../../contracts/index.ts";
import type { NewAuditEntry } from "../../infra/db/incident-store.ts";
import type { SimulatedInfra } from "../../infra/simulated-infra.ts";
import type { Clock } from "../../infra/clock.ts";
import type { Ids } from "../../infra/ids.ts";
import { classifyAction, EXECUTABLE_ACTIONS, isExecutable } from "../../domain/autonomy/catalog.ts";
import { ACTION_STATUS_LABELS } from "../../domain/report/postmortem-template.ts";
import type { TraceSink } from "../../app/trace-sink.ts";
import { runContextOf } from "../run-context.ts";
import type { NodeFn } from "../run-context.ts";

/** Gravação das ações, aprovações e auditoria (container: store.upsertAction, store.createApproval, store.appendAudit). */
export type GatePersist = { action(a: GatedAction): void; approval(a: Approval): void; audit(e: NewAuditEntry): AuditEntry };

export type GateDeps = { infra: SimulatedInfra; trace: TraceSink; clock: Clock; ids: Ids; approvalTtlMin: number; persist: GatePersist };

/** Duração simulada de um dry run (spec 7.5). */
export const DRY_RUN_SEC = 2;

const ACCEPTED: readonly GatedAction["status"][] = ["ready", "awaiting_approval"];

/** Argumentos do evento `action` no trace: o alvo primeiro, depois os parâmetros. */
export function actionArgs(a: Pick<GatedAction, "target" | "params">): Record<string, unknown> {
  const { target: _ignored, ...params } = a.params;
  return { target: a.target, ...params };
}

type Evaluated = { action: GatedAction; event: AuditEvent; summary: string };

export function createGateNode(d: GateDeps): NodeFn {
  return async (state, config) => {
    const ctx = runContextOf(state, config);
    if (state.plan === null || state.audit === null) throw new Error("gate invoked without an audited plan (the supervisor guard should prevent this)");
    const revisionsExhausted = state.audit.verdict === "revise";
    const scope = { service: state.alert.service, account: state.alert.account, incidentId: state.incidentId };
    const steps: PlanStep[] = [...state.plan.steps].sort((a, b) => a.order - b.order);

    // 1. Avalia o lote em ordem, com o mundo hipotético acumulando o efeito dos passos aceitos.
    let world = state.world;
    const evaluated: Evaluated[] = [];
    for (const step of steps) {
      const cls = classifyAction(step, { scope, revisionsExhausted });
      const action: GatedAction = {
        id: d.ids.action(), incidentId: state.incidentId, planRevision: state.planRevision, order: step.order,
        actionType: step.actionType, target: step.target, params: step.params, dependsOn: step.dependsOn,
        tier: cls.tier, classificationReasons: cls.reasons, status: "proposed", dryRun: null, approvalId: null,
        proposedBy: "remediation_planner", executedAt: null, resultSummary: null,
      };
      const head = `${step.actionType} tier ${cls.tier}`;
      if (cls.tier === 4 || !isExecutable(step.actionType)) {
        const forbidden = cls.known;
        action.status = forbidden ? "blocked_forbidden" : "blocked_unknown";
        evaluated.push({ action, event: forbidden ? "action_blocked_forbidden" : "action_blocked_unknown", summary: `${head}: blocked without dry run (${cls.reasons.join("; ")})` });
        continue;
      }
      if (!cls.paramsOk || cls.params === null) {
        action.status = "rejected_invalid_params";
        evaluated.push({ action, event: "action_rejected_invalid_params", summary: `${head}: invalid parameters, expected ${EXECUTABLE_ACTIONS[step.actionType].paramsText}; no dry run` });
        continue;
      }
      const blocker = step.dependsOn.find((n) => {
        const dep = evaluated.find((e) => e.action.order === n);
        return !dep || !ACCEPTED.includes(dep.action.status);
      });
      if (blocker !== undefined) {
        const dep = evaluated.find((e) => e.action.order === blocker);
        action.status = "cancelled";
        const why = dep ? ACTION_STATUS_LABELS[dep.action.status] : "not in the plan";
        evaluated.push({ action, event: "action_cancelled", summary: `${head}: cancelled, depends on step ${blocker} (${why})` });
        continue;
      }
      const validated = { actionType: step.actionType, target: step.target, params: cls.params };
      const dry = d.infra.dryRun(world, validated);
      d.clock.tick(DRY_RUN_SEC);
      action.dryRun = dry;
      if (!dry.ok) {
        action.status = "rejected_by_dry_run";
        evaluated.push({ action, event: "action_dry_run_failed", summary: `${head}: dry run falhou (${dry.failureReason})` });
        continue;
      }
      world = d.infra.apply(world, validated);
      const deps = step.dependsOn.length > 0 ? `, depends on step ${step.dependsOn.join(", ")}` : "";
      if (cls.tier === 2) {
        action.status = "ready";
        evaluated.push({ action, event: "action_ready", summary: `${head}: dry run ok (${dry.changes.join("; ")}) → ready, runs after the decisions${deps}` });
      } else {
        action.status = "awaiting_approval";
        evaluated.push({ action, event: "approval_requested", summary: `${head}: dry run ok (${dry.changes.join("; ")})${deps}` });
      }
    }

    // 2. Publica as decisões do lote no mesmo instante: aprovações, trace, ações e auditoria, na ordem do plano.
    const now = d.clock.now();
    const expiresAt = new Date(now.getTime() + d.approvalTtlMin * 60_000).toISOString();
    const pending: string[] = [];
    for (const e of evaluated) {
      const a = e.action;
      let summary = e.summary;
      if (a.status === "awaiting_approval") {
        const approval: Approval = {
          id: d.ids.approval(), incidentId: state.incidentId, actionId: a.id, status: "pending", requestedAt: now.toISOString(), expiresAt,
          decidedAt: null, approver: null, comment: null, decisionSource: null, version: 0,
        };
        d.persist.approval(approval);
        a.approvalId = approval.id;
        pending.push(approval.id);
        summary += ` → awaiting ${approval.id}`;
      }
      d.trace.emit(ctx, "gate", { type: "action", payload: { tool: a.actionType, args: actionArgs(a), tier: a.tier } });
      d.trace.emit(ctx, "gate", { type: "observation", payload: { tool: a.actionType, ok: ACCEPTED.includes(a.status), summary, evidenceRef: null } });
      if (a.tier === 4) {
        d.trace.emit(ctx, "gate", { type: "critique", payload: { by: "gate", verdict: "blocked", feedback: `${a.actionType} on ${a.target}: ${a.classificationReasons.join("; ")}` } });
      }
      d.persist.action(a);
      d.persist.audit({
        incidentId: state.incidentId,
        actor: "agent:gate",
        event: e.event,
        tier: a.tier,
        details: {
          actionId: a.id, order: a.order, actionType: a.actionType, target: a.target, status: a.status, reasons: a.classificationReasons,
          dryRun: a.dryRun === null ? null : (a.dryRun.failureReason ?? a.dryRun.changes.join("; ")),
          ...(a.approvalId ? { approvalId: a.approvalId, expiresAt } : {}),
          requestId: ctx.requestId,
        },
      });
    }

    const actions = evaluated.map((e) => e.action);
    const ready = actions.filter((a) => a.status === "ready").length;
    if (pending.length > 0) {
      d.trace.emit(ctx, "gate", {
        type: "handoff",
        payload: {
          from: "gate", to: "human",
          brief: `awaiting approval of ${pending.join(", ")}`,
          reason: `${pending.length} tier 3 step${pending.length === 1 ? "" : "s"} with a passing dry run require${pending.length === 1 ? "s" : ""} a human decision; nothing runs before all decisions`,
        },
      });
    } else if (ready > 0) {
      d.trace.emit(ctx, "gate", {
        type: "handoff",
        payload: { from: "gate", to: "executor", brief: `${ready} ${ready === 1 ? "action ready" : "actions ready"}, no pending approval`, reason: "no step in the batch requires a human decision" },
      });
    }
    return { actions, phase: pending.length > 0 ? "awaiting_approval" : "executing" };
  };
}
