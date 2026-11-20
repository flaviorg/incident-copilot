// Verifier (spec 4.6 and 6.7; AC-20). No LLM: waits for the canary window, compares the post-action series with the
// scenario's checks and, if it fails, reverts the executed reversible actions in reverse order, records a failure in the
// breaker and escalates with remediation_ineffective. If healthy, resets the breaker's failures and returns to the supervisor.
import type { CanaryCheckResult, GatedAction } from "../../contracts/index.ts";
import { EXECUTABLE_ACTIONS, isExecutable } from "../../domain/autonomy/catalog.ts";
import { analyzeCanary } from "../../domain/canary/canary-analyzer.ts";
import { clip } from "../../app/trace-sink.ts";
import { runContextOf } from "../run-context.ts";
import type { NodeFn } from "../run-context.ts";
import { actionArgs } from "./gate-node.ts";
import type { ExecutionDeps } from "./executor-node.ts";

/** Canary observation window (spec 7.5). */
const CANARY_WINDOW_SEC = 60;

const pt = (x: number, digits: number) => x.toLocaleString("en-US", { maximumFractionDigits: digits, useGrouping: false });
const usd = (x: number) => `US$ ${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })}`;

/** "5xx 0.5% ≤ 5%", "P99 205 ms ≤ 270 ms", "projected monthly cost US$ 356.94 ≤ US$ 600.00". */
function describeCheck(c: CanaryCheckResult): string {
  const op = c.passed ? "≤" : ">";
  if (c.observed === null) return `${c.metric} without data (limit ${pt(c.limit, 4)})`;
  switch (c.metric) {
    case "http_5xx_rate":
      return `5xx ${pt(c.observed * 100, 1)}% ${op} ${pt(c.limit * 100, 1)}%`;
    case "p99_latency_ms":
      return `P99 ${pt(c.observed, 0)} ms ${op} ${pt(c.limit, 0)} ms`;
    case "projected_monthly_cost_usd":
      return `projected monthly cost ${usd(c.observed)} ${op} ${usd(c.limit)}`;
    default:
      return `${c.metric} ${pt(c.observed, 4)} ${op} ${pt(c.limit, 4)}`;
  }
}

const isReversible = (a: GatedAction) => isExecutable(a.actionType) && EXECUTABLE_ACTIONS[a.actionType].reversible;

export function createVerifierNode(d: ExecutionDeps): NodeFn {
  return async (state, config) => {
    const ctx = runContextOf(state, config);
    const scenario = d.scenarios.get(state.scenarioId, { offsetSec: state.timeOffsetSec });
    d.clock.tick(CANARY_WINDOW_SEC);
    const r = analyzeCanary(scenario.file.canary, d.infra.postActionSignals(state.world, scenario), scenario.file.baselines);
    const checks = r.checks.map(describeCheck).join("; ");

    if (r.healthy) {
      d.guards.breaker.recordSuccess(d.clock.now());
      d.trace.emit(ctx, "verifier", { type: "critique", payload: { by: "canary", verdict: "approve", feedback: `healthy canary: ${checks}` } });
      d.trace.emit(ctx, "verifier", {
        type: "handoff",
        payload: { from: "verifier", to: "supervisor", brief: "healthy canary; incident mitigated", reason: "every canary check passed in the post-action window" },
      });
      return { verification: { healthy: true, checks: r.checks, revertedActionIds: [] }, actions: state.actions, world: state.world, phase: "verifying" };
    }

    d.trace.emit(ctx, "verifier", { type: "critique", payload: { by: "canary", verdict: "reject", feedback: `failed canary: ${checks}` } });
    let world = state.world;
    const actions = state.actions.map((a) => ({ ...a }));
    const toRevert = actions
      .filter((a) => a.status === "succeeded" && isReversible(a))
      .sort((a, b) => (b.executedAt ?? "").localeCompare(a.executedAt ?? "") || b.order - a.order);
    const reverted: string[] = [];
    const revertFailed: { id: string; actionType: string; summary: string }[] = [];
    for (const a of toRevert) {
      const tool = `revert:${a.actionType}`;
      d.trace.emit(ctx, "verifier", { type: "action", payload: { tool, args: actionArgs(a), tier: a.tier } });
      const res = d.infra.revert(world, a);
      if (isExecutable(a.actionType)) d.clock.tick(EXECUTABLE_ACTIONS[a.actionType].durationSec);
      if (res.result.ok) {
        world = res.world;
        a.status = "reverted";
        a.resultSummary = res.result.summary;
        reverted.push(a.id);
        d.persist.action(a);
      } else {
        // Review 2026-11: the change is still in the world. Keep status succeeded (that is the truth) but say so in the
        // action, the audit and the escalation, so the on-call human does not read "rolled back".
        a.resultSummary = clip(`${a.resultSummary ?? "executed"}; revert FAILED: ${res.result.summary}`, 300);
        revertFailed.push({ id: a.id, actionType: a.actionType, summary: res.result.summary });
        d.persist.action(a);
      }
      d.trace.emit(ctx, "verifier", { type: "observation", payload: { tool, ok: res.result.ok, summary: res.result.summary, evidenceRef: null } });
    }
    d.persist.audit({
      incidentId: state.incidentId,
      actor: "system:canary",
      event: "canary_rollback",
      tier: null,
      details: {
        failedChecks: r.checks.filter((c) => !c.passed).map(describeCheck), revertedActionIds: reverted,
        revertFailedActionIds: revertFailed.map((f) => f.id), requestId: ctx.requestId,
      },
    });
    if (d.guards.breaker.recordFailure(d.clock.now())) {
      d.persist.audit({
        incidentId: state.incidentId, actor: "system:circuit-breaker", event: "circuit_opened", tier: null,
        details: { cause: "canary failed after execution", requestId: ctx.requestId },
      });
    }
    const revertedTypes = toRevert.filter((a) => reverted.includes(a.id)).map((a) => a.actionType);
    return {
      verification: { healthy: false, checks: r.checks, revertedActionIds: reverted },
      actions,
      world,
      escalation: {
        reason: "remediation_ineffective",
        detail: clip(
          [
            revertFailed.map((f) => `revert of ${f.actionType} FAILED: ${f.summary}`).join("; "),
            `failed canary (${checks})`,
            revertedTypes.length > 0 ? `reverted in reverse order: ${revertedTypes.join(", ")}` : revertFailed.length > 0 ? "" : "nothing to revert",
          ].filter((s) => s !== "").join("; "),
          400,
        ),
      },
      phase: "verifying",
    };
  };
}
