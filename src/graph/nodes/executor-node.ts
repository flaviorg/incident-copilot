// Executor (spec 4.6, 5.1 passo 11, 6.5 e 6.7; AC-14 e AC-19). Sem LLM: executa em ordem as ações prontas e aprovadas,
// respeitando dependsOn, o circuit breaker e o limite de execuções; cada execução avança o relógio pela duração do
// catálogo e é auditada. Sem nenhuma ação mitigadora executada, devolve escalonamento (a aresta seguinte desvia).
import type { EscalationReason, GatedAction } from "../../contracts/index.ts";
import type { SimulatedInfra } from "../../infra/simulated-infra.ts";
import type { ScenarioRepository } from "../../infra/scenarios/scenario-loader.ts";
import type { Clock } from "../../infra/clock.ts";
import type { CircuitBreaker } from "../../domain/guards/circuit-breaker.ts";
import type { ActionRateLimiter } from "../../domain/guards/action-rate-limiter.ts";
import { EXECUTABLE_ACTIONS, isExecutable, isMitigating } from "../../domain/autonomy/catalog.ts";
import { ACTION_STATUS_LABELS } from "../../domain/report/postmortem-template.ts";
import { clip } from "../../app/trace-sink.ts";
import type { TraceSink } from "../../app/trace-sink.ts";
import { runContextOf } from "../run-context.ts";
import type { NodeFn } from "../run-context.ts";
import { actionArgs } from "./gate-node.ts";
import type { GatePersist } from "./gate-node.ts";

/** Por processo (spec 6.7): estado em memória, compartilhado por todas as execuções do container. */
export type ExecutionGuards = { breaker: CircuitBreaker; limiter: ActionRateLimiter };

export type ExecutionDeps = {
  infra: SimulatedInfra;
  scenarios: ScenarioRepository;
  guards: ExecutionGuards;
  trace: TraceSink;
  clock: Clock;
  persist: GatePersist;
};

/** Prioridade da tabela 4.5.1: circuit_open, throttled, mitigation_rejected (alguma rejeitada ou expirada), no_executable_actions. */
export function executorEscalationReason(actions: GatedAction[]): EscalationReason {
  if (actions.some((a) => a.status === "blocked_circuit_open")) return "circuit_open";
  if (actions.some((a) => a.status === "throttled")) return "throttled";
  if (actions.some((a) => a.status === "rejected" || a.status === "expired")) return "mitigation_rejected";
  return "no_executable_actions";
}

const RUNNABLE: readonly GatedAction["status"][] = ["ready", "approved"];

function escalationDetail(actions: GatedAction[]): string {
  const mitigating = actions.filter((a) => isMitigating(a.actionType));
  if (mitigating.length === 0) return "nenhuma ação mitigadora executada: o lote não tinha ação mitigadora";
  return clip(`nenhuma ação mitigadora executada: ${mitigating.map((a) => `${a.actionType} ${ACTION_STATUS_LABELS[a.status]}`).join(", ")}`, 400);
}

export function createExecutorNode(d: ExecutionDeps): NodeFn {
  return async (state, config) => {
    const ctx = runContextOf(state, config);
    const scenario = d.scenarios.get(state.scenarioId, { offsetSec: state.timeOffsetSec });

    if (state.phase === "resume") {
      const decided = state.actions.filter((a) => a.approvalId !== null);
      const count = (s: GatedAction["status"]) => decided.filter((a) => a.status === s).length;
      d.trace.emit(ctx, "human", {
        type: "handoff",
        payload: {
          from: "human", to: "executor",
          brief: `decisões registradas: ${count("approved")} aprovada(s), ${count("rejected")} rejeitada(s), ${count("expired")} expirada(s)`,
          reason: "todas as aprovações do lote foram decididas; a execução do lote pode começar",
        },
      });
    }

    let world = state.world;
    const actions = state.actions.map((a) => ({ ...a }));
    const audit = (a: GatedAction, event: "action_executed" | "action_failed" | "action_throttled" | "action_blocked_circuit_open" | "action_cancelled", extra: Record<string, unknown> = {}) =>
      d.persist.audit({
        incidentId: state.incidentId,
        actor: "agent:executor",
        event,
        tier: a.tier,
        details: { actionId: a.id, order: a.order, actionType: a.actionType, target: a.target, status: a.status, approvalId: a.approvalId, ...extra, requestId: ctx.requestId },
      });
    const observe = (a: GatedAction, ok: boolean, summary: string) =>
      d.trace.emit(ctx, "executor", { type: "observation", payload: { tool: a.actionType, ok, summary: `${a.actionType}: ${summary}`, evidenceRef: null } });

    for (const a of [...actions].sort((x, y) => x.order - y.order)) {
      if (!RUNNABLE.includes(a.status)) continue;
      const now = d.clock.now();
      const blocker = a.dependsOn.find((n) => actions.find((x) => x.order === n)?.status !== "succeeded");
      if (blocker !== undefined) {
        const dep = actions.find((x) => x.order === blocker);
        a.status = "cancelled";
        a.resultSummary = `cancelada: depende do passo ${blocker} (${dep ? ACTION_STATUS_LABELS[dep.status] : "inexistente"})`;
        observe(a, false, a.resultSummary);
        d.persist.action(a);
        audit(a, "action_cancelled", { dependsOn: a.dependsOn });
        continue;
      }
      if (!d.guards.breaker.canExecute(now)) {
        a.status = "blocked_circuit_open";
        a.resultSummary = "não executada: circuit breaker aberto";
        observe(a, false, a.resultSummary);
        d.persist.action(a);
        audit(a, "action_blocked_circuit_open");
        continue;
      }
      const permit = d.guards.limiter.tryAcquire(a.actionType, a.target, now);
      if (!permit.ok) {
        a.status = "throttled";
        a.resultSummary = permit.reason === "global" ? "não executada: limite global de execuções por minuto" : "não executada: a mesma ação já rodou neste alvo há pouco";
        observe(a, false, a.resultSummary);
        d.persist.action(a);
        audit(a, "action_throttled", { limit: permit.reason });
        continue;
      }
      if (!isExecutable(a.actionType)) throw new Error(`ação ${a.id} (${a.actionType}) pronta sem estar no catálogo: defeito do portão`);

      d.trace.emit(ctx, "executor", { type: "action", payload: { tool: a.actionType, args: actionArgs(a), tier: a.tier } });
      const r = d.infra.execute(world, { actionType: a.actionType, target: a.target, params: a.params }, scenario);
      d.clock.tick(EXECUTABLE_ACTIONS[a.actionType].durationSec);
      a.executedAt = now.toISOString();
      a.resultSummary = r.result.summary;
      if (r.result.ok) {
        a.status = "succeeded";
        world = r.world;
        observe(a, true, r.result.summary);
        d.persist.action(a);
        audit(a, "action_executed", { summary: r.result.summary });
      } else {
        a.status = "failed";
        observe(a, false, `falhou (${r.result.summary})`);
        d.persist.action(a);
        audit(a, "action_failed", { summary: r.result.summary });
        if (d.guards.breaker.recordFailure(d.clock.now())) {
          d.persist.audit({
            incidentId: state.incidentId, actor: "system:circuit-breaker", event: "circuit_opened", tier: null,
            details: { cause: `falha de execução de ${a.actionType} em ${a.target}`, requestId: ctx.requestId },
          });
        }
      }
    }

    const mitigated = actions.some((a) => a.status === "succeeded" && isMitigating(a.actionType));
    if (!mitigated) {
      return { actions, world, phase: "executing", escalation: { reason: executorEscalationReason(actions), detail: escalationDetail(actions) } };
    }
    return { actions, world, phase: "executing" };
  };
}
