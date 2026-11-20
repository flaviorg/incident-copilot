// Runbook retriever (spec 4.6 and 5.1, step 5): BM25 per section with a normalized threshold and refusal. Receives no LLM.
import type { Blackboard, RootCauseCategory } from "../../contracts/index.ts";
import type { RunbookRepository } from "../../infra/runbooks/runbook-repository.ts";
import type { TraceSink } from "../../app/trace-sink.ts";
import { runContextOf } from "../run-context.ts";
import type { NodeFn } from "../run-context.ts";

/** Words that pull the right sections per cause category. */
const CATEGORY_KEYWORDS: Record<RootCauseCategory, string> = {
  bad_deploy: "deploy rollback previous version block image tag",
  resource_leak: "memory leak restart",
  capacity: "capacity saturation replicas",
  cost_anomaly: "cost idle volume snapshot instance delete release resize",
  vulnerability: "vulnerability image cve",
  dependency_failure: "dependency timeout database connections",
  config_error: "configuration parameter change",
  unknown: "",
};

const fmtScore = (x: number) => x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });

/** Alert rule + hypothesis + evidence summaries + category words; filtered by the alert's service. */
export function buildRunbookQuery(bb: Blackboard): { text: string; service: string | null } {
  const d = bb.diagnosis;
  const parts = [bb.alert.rule];
  if (d) parts.push(d.hypothesis, ...d.evidence.map((e) => e.summary), CATEGORY_KEYWORDS[d.category]);
  else parts.push(bb.alert.title);
  return { text: parts.filter((p) => p.trim() !== "").join(" "), service: bb.alert.service };
}

export function createRunbooksNode(d: { runbooks: RunbookRepository; trace: TraceSink }): NodeFn {
  return async (state, config) => {
    const ctx = runContextOf(state, config);
    const q = buildRunbookQuery(state);
    d.trace.emit(ctx, "runbook_retriever", { type: "action", payload: { tool: "search_runbooks", args: { query: q.text }, tier: 1 } });
    const matches = d.runbooks.search(q, { limit: 3 });
    const summary = matches.length === 0
      ? "no runbook above the threshold (refusal)"
      : matches.map((m) => `${m.runbookId}@${m.version} §${m.section} (normalized score ${fmtScore(m.normalizedScore)})`).join("; ");
    const top = matches[0];
    d.trace.emit(ctx, "runbook_retriever", {
      type: "observation",
      payload: { tool: "search_runbooks", ok: true, summary, evidenceRef: top ? `runbook:${top.runbookId}@${top.version}#${top.section}` : null },
    });
    d.trace.emit(ctx, "runbook_retriever", {
      type: "handoff",
      payload: {
        from: "runbook_retriever",
        to: "supervisor",
        brief: matches.length === 0 ? "no runbook above the threshold (refusal)" : `${matches.length} runbook ${matches.length === 1 ? "passage" : "passages"}: ${matches.map((m) => `${m.runbookId}#${m.section}`).join(", ")}`,
        reason: "runbook search completed",
      },
    });
    return { runbookMatches: matches, runbookSearchDone: true, phase: "planning" };
  };
}
