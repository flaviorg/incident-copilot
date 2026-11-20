// CLI output formatting (text for people, in English with en-US number formats).
import type { ToolResult } from "../tools/registry.ts";
import type { IncidentMetrics, TraceEvent } from "../contracts/index.ts";
import { AGENT_LABELS } from "../domain/report/postmortem-template.ts";

/** Table with columns aligned by spaces. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export function renderToolResult(o: { name: string; scenarioId: string; now: string; result: ToolResult }): string {
  const r = o.result;
  return [
    `tool: ${o.name} (tier 1, read-only) | scenario: ${o.scenarioId} | now: ${o.now}`,
    `ok: ${r.ok ? "yes" : "no"}`,
    r.summary,
    `evidence: ${r.evidenceRef ?? "none"}`,
    "",
    JSON.stringify(r, null, 2),
  ].join("\n");
}

const time = (iso: string) => iso.slice(11, 19);
const oneLine = (s: string, max = 220) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
};
const argValues = (args: Record<string, unknown>) =>
  Object.values(args).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ");

const VERDICT_LABELS: Record<string, string> = {
  approve: "approved", revise: "asks for revision", reject: "rejected", coerced: "choice corrected", blocked: "blocked",
};
const CRITIC_LABELS: Record<string, string> = {
  auditor: "auditor", supervisor_guard: "supervisor guard", gate: "gate", numeric_guard: "numeric guard", canary: "canary",
};

/** One line per event in the spec 10.3 format: time, 2-space indent for chat and 4 for steps. */
export function renderEvent(e: TraceEvent): string | null {
  const t = time(e.ts);
  switch (e.type) {
    case "handoff":
      return `${t}  ${AGENT_LABELS[e.payload.from]} → ${AGENT_LABELS[e.payload.to]}: ${oneLine(e.payload.brief)}`;
    case "thought":
      return `${t}    think ${oneLine(e.payload.text)}`;
    case "action":
      return `${t}    act   ${e.payload.tool}(${oneLine(argValues(e.payload.args), 160)})${e.payload.tier === null ? "" : ` · tier ${e.payload.tier}`}`;
    case "observation":
      // At the gate, ok=false means "did not pass the gate" (the summary already says why), not a tool failure.
      return `${t}    obs   ${e.payload.ok || e.agent === "gate" ? "" : "failed: "}${oneLine(e.payload.summary)}`;
    case "plan":
      return `${t}  ${AGENT_LABELS[e.agent]}: plan revision ${e.payload.revision} with ${e.payload.steps.length} step${e.payload.steps.length === 1 ? "" : "s"}: ${oneLine(e.payload.summary, 160)}`;
    case "critique":
      return `${t}  ${CRITIC_LABELS[e.payload.by] ?? e.payload.by}: ${VERDICT_LABELS[e.payload.verdict] ?? e.payload.verdict} (${oneLine(e.payload.feedback, 200)})`;
    case "answer":
      return `${t}  ${AGENT_LABELS[e.agent]}: ${oneLine(e.payload.text, 260)}`;
  }
}

const one = (x: number) => x.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false });
const usd = (x: number) => `US$ ${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })}`;
const times = (x: number) => `${x.toLocaleString("en-US", { maximumFractionDigits: 1, useGrouping: false })}x`;
const row = (label: string, value: string, note: string) => `${label.padEnd(24)}${value.padEnd(16)}${note}`;

/**
 * Numbers panel (spec 5.7 and 10.3): MTTR and time waiting for approval highlighted; minutes saved and ROI as a
 * range labeled "illustrative"; monthly savings when present.
 */
export function renderMetrics(m: IncidentMetrics): string[] {
  const lines: string[] = [];
  lines.push(m.mttrMin === null
    ? row("MTTR", "not resolved", "measured (incident escalated, no healthy verification)")
    : row("MTTR", `${one(m.mttrMin)} min`, `measured (simulated timeline, ${time(m.impactStartedAt)} → ${time(m.resolvedAt ?? m.detectedAt)})`));
  lines.push(row("  awaiting approval", `${one(m.timeAwaitingApprovalMin)} min`, "measured (sum of decided approvals)"));
  lines.push(row("MTTD", `${one(m.mttdMin)} min`, "measured"));
  if (m.monthlySavingsUsd > 0) lines.push(row("Monthly savings", usd(m.monthlySavingsUsd), "derived (inventory findings of executed actions)"));
  if (m.minutesSaved) {
    lines.push(row("Minutes saved", `${one(m.minutesSaved.low)} to ${one(m.minutesSaved.high)}`, `illustrative (synthetic baseline of ${m.baselineMttrMin.low} to ${m.baselineMttrMin.high} min)`));
  }
  if (m.roiIllustrative) {
    lines.push(row("ROI", `${times(m.roiIllustrative.low)} to ${times(m.roiIllustrative.high)}`, "illustrative (assumptions in data/business-assumptions.json)"));
  }
  lines.push(row("LLM cost", usd(m.llmCostUsd), `measured (${m.llmCalls} calls, ${m.promptTokens + m.completionTokens} tokens)`));
  return lines;
}
