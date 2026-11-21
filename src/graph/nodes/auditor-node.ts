// Plan auditor (spec 4.7; lesson 221513 Reflection with a floor in code): deterministic rules first, then auditor.v1.
// The LLM may harden the verdict, never loosen it; LLM unavailable does not escalate, the rules apply.
import { DeployRecordSchema, DeploySchema } from "../../contracts/index.ts";
import type { Blackboard, Deploy, DeployRecord, Limits } from "../../contracts/index.ts";
import { aliasFor } from "../../domain/ingest/service-map.ts";
import type { IncidentContext, IncidentContextResolver } from "../../tools/context.ts";
import type { LlmProvider } from "../../llm/provider.ts";
import { auditorPrompt } from "../../prompts/v1/index.ts";
import { combineAuditorVerdict, runAuditorRules } from "../../domain/audit/auditor-rules.ts";
import { impactStartOf } from "../../domain/metrics/incident-metrics.ts";
import { clip, llmInfoOf } from "../../app/trace-sink.ts";
import type { TraceSink } from "../../app/trace-sink.ts";
import { runContextOf } from "../run-context.ts";
import type { NodeFn } from "../run-context.ts";

/** Per-source deadline of the deploy lookup of a live incident (same as a live tool call). */
const LIVE_DEPLOYS_TIMEOUT_MS = 10_000;

/**
 * Deploys of the alert's service from every source with a deploys capability, since an hour before the impact,
 * mapped to the Deploy contract the auditor rules read. A failing source or an invalid record is skipped: the rules
 * then see fewer deploys, never a made-up one.
 */
async function liveDeploys(incident: Extract<IncidentContext, { kind: "live" }>, alert: Blackboard["alert"], signal: AbortSignal): Promise<Deploy[]> {
  const service = alert.service;
  if (service === null) return [];
  const since = new Date(Date.parse(alert.detectedAt) - 60 * 60_000);
  const out: Deploy[] = [];
  for (const s of incident.sources) {
    if (typeof s.query.deploys !== "function") continue;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(LIVE_DEPLOYS_TIMEOUT_MS)]);
    let records: DeployRecord[];
    try {
      const raw = await Promise.race([
        s.query.deploys({ service: aliasFor(incident.services, s.connectorId, service), since }, { signal: deadline, now: new Date(alert.detectedAt) }),
        new Promise<never>((_, reject) => deadline.addEventListener("abort", () => reject(new Error("timeout")), { once: true })),
      ]);
      records = (Array.isArray(raw) ? raw : []).flatMap((r) => {
        const p = DeployRecordSchema.safeParse(r);
        return p.success ? [p.data] : [];
      });
    } catch {
      continue;
    }
    const sorted = [...records].sort((a, b) => b.at.localeCompare(a.at));
    sorted.forEach((r, i) => {
      const d = DeploySchema.safeParse({ service, version: r.version, previousVersion: sorted[i + 1]?.version ?? "unknown", at: r.at, replicas: 1 });
      if (d.success) out.push(d.data);
    });
  }
  return out;
}

/** `limits` only decides who the handoff goes to, so the trace says the same as the afterAuditor edge. */
export function createAuditorNode(d: { llm: LlmProvider; trace: TraceSink; context: IncidentContextResolver; limits: Limits }): NodeFn {
  return async (state, config) => {
    const ctx = runContextOf(state, config);
    if (state.plan === null || state.diagnosis === null) throw new Error("auditor invoked without a plan or a diagnosis");
    const incident = d.context.resolve(state);
    const checks = runAuditorRules(
      state.plan,
      incident.kind === "scenario"
        ? {
          inventory: state.world.inventory ?? incident.scenario.inventory,
          deploys: incident.scenario.deploys,
          impactStartedAt: impactStartOf(incident.scenario.alert, incident.scenario.series),
        }
        : { inventory: null, deploys: await liveDeploys(incident, state.alert, ctx.signal), impactStartedAt: state.alert.detectedAt },
    );
    const r = await d.llm.generate(auditorPrompt, { diagnosis: state.diagnosis, plan: state.plan, checks, revision: state.planRevision }, ctx);
    const llmVerdict = r.success ? r.data.verdict : null;
    const { verdict, overridden } = combineAuditorVerdict(checks, llmVerdict);
    const failed = checks.filter((c) => !c.passed).map((c) => c.rule);
    let feedback = r.success ? r.data.feedback : `model unavailable (${r.error.kind}); verdict by the rules`;
    if (failed.length > 0) feedback += ` | failed rules: ${failed.join(", ")}`;
    if (overridden) feedback += " | model verdict overridden by the rules";
    feedback = clip(feedback, 600);

    d.trace.emit(ctx, "auditor", { type: "critique", payload: { by: "auditor", verdict, feedback, overridden } }, llmInfoOf(auditorPrompt, r));
    const backToPlanner = verdict === "revise" && state.planRevision < d.limits.maxPlanRevisions;
    const passed = checks.filter((c) => c.passed).length;
    d.trace.emit(ctx, "auditor", {
      type: "handoff",
      payload: {
        from: "auditor",
        to: backToPlanner ? "remediation_planner" : "supervisor",
        brief: backToPlanner ? clip(`revise the plan: ${feedback}`, 400) : `plan revision ${state.planRevision} ${verdict === "approve" ? "approved" : "with revisions exhausted"} (${passed} of ${checks.length} rules ok)`,
        reason: overridden ? "rules in code rejected the plan despite the model" : `verdict ${verdict === "approve" ? "approved" : "revise"}`,
      },
    });
    return { audit: { verdict, feedback, checks, llmVerdict, overridden }, phase: "planning" };
  };
}
