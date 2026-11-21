// Executor (spec 4.6, 5.1 step 11, 6.5 and 6.7; AC-14 and AC-19). No LLM: runs the ready, approved actions in order,
// respecting dependsOn, the circuit breaker and the execution limit; each execution advances the clock by the catalog
// duration and is audited. With no mitigating action executed, returns an escalation (the next edge diverts).
import type { EscalationReason, GatedAction } from "../../contracts/index.ts";
import type { SimulatedInfra } from "../../infra/simulated-infra.ts";
import type { IncidentContextResolver } from "../../tools/context.ts";
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

/** Per process (spec 6.7): in-memory state, shared by all runs of the container. */
export type ExecutionGuards = { breaker: CircuitBreaker; limiter: ActionRateLimiter };

export type ExecutionDeps = {
  infra: SimulatedInfra;
  context: IncidentContextResolver;
  guards: ExecutionGuards;
  trace: TraceSink;
  clock: Clock;
  persist: GatePersist;
};

/** Priority from table 4.5.1: circuit_open, throttled, mitigation_rejected (any rejected or expired), no_executable_actions. */
export function executorEscalationReason(actions: GatedAction[]): EscalationReason {
  if (actions.some((a) => a.status === "blocked_circuit_open")) return "circuit_open";
  if (actions.some((a) => a.status === "throttled")) return "throttled";
  if (actions.some((a) => a.status === "rejected" || a.status === "expired")) return "mitigation_rejected";
  return "no_executable_actions";
}

const RUNNABLE: readonly GatedAction["status"][] = ["ready", "approved"];

function escalationDetail(actions: GatedAction[]): string {
  const mitigating = actions.filter((a) => isMitigating(a.actionType));
  if (mitigating.length === 0) return "no mitigating action executed: the batch had no mitigating action";
  return clip(`no mitigating action executed: ${mitigating.map((a) => `${a.actionType} ${ACTION_STATUS_LABELS[a.status]}`).join(", ")}`, 400);
}

export function createExecutorNode(d: ExecutionDeps): NodeFn {
  return async (state, config) => {
    const ctx = runContextOf(state, config);
    const incident = d.context.resolve(state);
    if (incident.kind === "live") throw new Error("executor reached for a live incident; shadow mode routes the gate to the reporter");
    const scenario = incident.scenario;

    if (state.phase === "resume") {
      const decided = state.actions.filter((a) => a.approvalId !== null);
      const count = (s: GatedAction["status"]) => decided.filter((a) => a.status === s).length;
      d.trace.emit(ctx, "human", {
        type: "handoff",
        payload: {
          from: "human", to: "executor",
          brief: `decisions recorded: ${count("approved")} approved, ${count("rejected")} rejected, ${count("expired")} expired`,
          reason: "all approvals in the batch were decided; batch execution can start",
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

    // Half-open, the whole batch is the trial: once this batch holds it, its remaining steps run, a failure reopens the
    // breaker, and the verifier records the outcome. A batch that ends without one hands the trial back (see below).
    let holdsTrial = false;
    const breakerAllows = (now: Date): boolean => {
      if (holdsTrial) return true;
      const halfOpen = d.guards.breaker.state(now) === "half_open";
      const ok = d.guards.breaker.canExecute(now);
      if (ok && halfOpen) holdsTrial = true;
      return ok;
    };

    for (const a of [...actions].sort((x, y) => x.order - y.order)) {
      if (!RUNNABLE.includes(a.status)) continue;
      const now = d.clock.now();
      const blocker = a.dependsOn.find((n) => actions.find((x) => x.order === n)?.status !== "succeeded");
      if (blocker !== undefined) {
        const dep = actions.find((x) => x.order === blocker);
        a.status = "cancelled";
        a.resultSummary = `cancelled: depends on step ${blocker} (${dep ? ACTION_STATUS_LABELS[dep.status] : "nonexistent"})`;
        observe(a, false, a.resultSummary);
        d.persist.action(a);
        audit(a, "action_cancelled", { dependsOn: a.dependsOn });
        continue;
      }
      if (!breakerAllows(now)) {
        a.status = "blocked_circuit_open";
        a.resultSummary = "not executed: circuit breaker open";
        observe(a, false, a.resultSummary);
        d.persist.action(a);
        audit(a, "action_blocked_circuit_open");
        continue;
      }
      const permit = d.guards.limiter.tryAcquire(a.actionType, a.target, now);
      if (!permit.ok) {
        a.status = "throttled";
        a.resultSummary = permit.reason === "global" ? "not executed: global limit of executions per minute" : "not executed: the same action already ran on this target recently";
        observe(a, false, a.resultSummary);
        d.persist.action(a);
        audit(a, "action_throttled", { limit: permit.reason });
        continue;
      }
      if (!isExecutable(a.actionType)) throw new Error(`action ${a.id} (${a.actionType}) ready without being in the catalog: gate defect`);

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
        observe(a, false, `failed (${r.result.summary})`);
        d.persist.action(a);
        audit(a, "action_failed", { summary: r.result.summary });
        const opened = d.guards.breaker.recordFailure(d.clock.now());
        if (opened) {
          holdsTrial = false; // the trial failed: the breaker reopened and blocks the rest of the batch
          d.persist.audit({
            incidentId: state.incidentId, actor: "system:circuit-breaker", event: "circuit_opened", tier: null,
            details: { cause: `execution failure of ${a.actionType} on ${a.target}`, requestId: ctx.requestId },
          });
        }
      }
    }

    const mitigated = actions.some((a) => a.status === "succeeded" && isMitigating(a.actionType));
    if (!mitigated) {
      // The verifier only runs after a mitigation; without one, this trial has no outcome and must not stay taken.
      if (holdsTrial) d.guards.breaker.releaseTrial();
      return { actions, world, phase: "executing", escalation: { reason: executorEscalationReason(actions), detail: escalationDetail(actions) } };
    }
    return { actions, world, phase: "executing" };
  };
}
