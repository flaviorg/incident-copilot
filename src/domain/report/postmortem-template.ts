// Template determinístico do post-mortem (spec 5.2 e 6.1): narrativa sem LLM e Markdown com seções fixas. Puro.
import type {
  ActionStatus, AgentId, Confidence, Diagnosis, EscalationReason, IncidentMetrics, PostmortemDoc, PostmortemNarrative, RootCauseCategory,
} from "../../contracts/index.ts";
import { checkNarrative, collectAllowedNumbers } from "./numeric-guard.ts";

export type TemplateInput = {
  title: string;
  status: "final" | "partial";
  metrics: IncidentMetrics;
  diagnosis: Diagnosis | null;
  actions: PostmortemDoc["actions"];
  escalation: { reason: EscalationReason; detail: string } | null;
};

export const CATEGORY_LABELS: Record<RootCauseCategory, string> = {
  bad_deploy: "faulty deploy",
  resource_leak: "resource leak",
  capacity: "capacity",
  cost_anomaly: "cost anomaly",
  vulnerability: "vulnerability",
  dependency_failure: "dependency failure",
  config_error: "configuration error",
  unknown: "unknown",
};

/** Nome de cada agente na interface (spec 4.6). */
export const AGENT_LABELS: Record<AgentId, string> = {
  supervisor: "supervisor",
  telemetry_analyst: "telemetry analyst",
  runbook_retriever: "runbook retriever",
  remediation_planner: "remediation planner",
  auditor: "auditor",
  gate: "remediation gate",
  executor: "executor",
  verifier: "verifier",
  reporter: "reporter",
  human: "human",
  system: "system",
  mcp_client: "MCP client",
};

export const CONFIDENCE_LABELS: Record<Confidence, string> = { low: "low", medium: "medium", high: "high" };

export const ESCALATION_LABELS: Record<EscalationReason, string> = {
  team_cap_reached: "team iteration cap reached",
  react_cap_low_confidence: "analyst step cap reached with low confidence",
  low_confidence_diagnosis: "diagnosis still at low confidence after the allowed rounds",
  recursion_limit: "graph recursion limit reached",
  llm_unavailable: "LLM unavailable",
  timeout: "execution timed out",
  mitigation_rejected: "mitigation rejected by a human",
  remediation_ineffective: "ineffective remediation (canary failed)",
  throttled: "execution limit reached",
  circuit_open: "circuit breaker open",
  no_executable_actions: "no executable actions",
};

export const ACTION_STATUS_LABELS: Record<ActionStatus, string> = {
  proposed: "proposed",
  blocked_forbidden: "blocked (forbidden)",
  blocked_unknown: "blocked (not in catalog)",
  rejected_invalid_params: "refused (invalid parameters)",
  rejected_by_dry_run: "refused by dry run",
  awaiting_approval: "awaiting approval",
  approved: "approved",
  rejected: "rejected",
  expired: "expired",
  ready: "ready",
  succeeded: "executed",
  failed: "failed",
  throttled: "throttled (execution rate)",
  blocked_circuit_open: "blocked (circuit breaker open)",
  cancelled: "cancelled",
  reverted: "reverted",
};

const PREVENTION: Partial<Record<RootCauseCategory, string[]>> = {
  bad_deploy: [
    "Promote releases with a gradual rollout and an automatic canary before reaching every replica.",
    "Cover with tests the optional fields read by the code changed in the deploy.",
    "Keep the previous version ready for rollback and make clear who can approve it.",
  ],
  cost_anomaly: [
    "Tag resources with an owner and a review date to avoid orphaned resources.",
    "Run the inventory audit every week and alert when daily cost drifts from the average.",
    "Take a snapshot before deleting volumes and never delete backups to cut cost.",
  ],
};
const DEFAULT_PREVENTION = [
  "Review the signals that fired the alert and tune thresholds and dashboards.",
  "Record what this incident taught in the matching runbook.",
];

const fmtFixed = (n: number, d: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: false }).format(n);

/**
 * Inteiro sem casas; senão, a partir de `preferredDigits` casas (1, como na exibição), o mínimo que mantém o erro
 * relativo em até 0,4% (abaixo da tolerância do guarda numérico, 0,5%).
 */
export function formatForNarrative(n: number, preferredDigits = 1): string {
  if (Number.isInteger(n)) return fmtFixed(n, 0);
  for (let d = preferredDigits; d <= 4; d++) {
    const r = Math.round(n * 10 ** d) / 10 ** d;
    if (Math.abs(r - n) <= 0.004 * Math.abs(n)) return fmtFixed(r, d);
  }
  return fmtFixed(n, 4);
}

const usd = (n: number) => `US$ ${fmtFixed(n, 2)}`;
const clock = (iso: string) => iso.slice(11, 19);
const truncate = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max - 1) + "…");

/** Frase única para pessoas: motivo do escalonamento e, entre parênteses, o detalhe (que é um fragmento em minúsculas). */
export function escalationSentence(e: { reason: EscalationReason; detail: string }): string {
  const detail = e.detail.trim().replace(/[.;:,\s]+$/, "");
  return `Incident escalated to humans: ${ESCALATION_LABELS[e.reason]}${detail ? ` (${detail})` : ""}.`;
}

export function renderTemplateNarrative(i: TemplateInput): PostmortemNarrative {
  const m = i.metrics;
  const evidence = i.diagnosis?.evidence ?? [];
  const allowed = collectAllowedNumbers({ metrics: m, timeline: [], evidence, counts: [i.actions.length] });

  const s: string[] = [];
  if (i.escalation) {
    s.push(escalationSentence(i.escalation));
    s.push("This report is partial and was generated by the deterministic template.");
  } else if (i.status === "final") {
    s.push("Incident resolved.");
  } else {
    s.push("Incident not yet resolved; partial report.");
  }
  s.push(`Impact started at ${clock(m.impactStartedAt)} UTC and was detected in ${formatForNarrative(m.mttdMin)} min.`);
  if (m.mttrMin !== null) {
    const waiting = m.timeAwaitingApprovalMin > 0 ? `, of which ${formatForNarrative(m.timeAwaitingApprovalMin)} min were spent awaiting human approval` : "";
    s.push(`Resolution took ${formatForNarrative(m.mttrMin)} min from the start of impact (MTTR)${waiting}.`);
  }
  if (m.monthlySavingsUsd > 0) s.push(`Monthly savings calculated from the executed actions: ${usd(m.monthlySavingsUsd)}.`);
  if (m.minutesSaved) {
    s.push(
      `Against the synthetic baseline of ${formatForNarrative(m.baselineMttrMin.low)} to ${formatForNarrative(m.baselineMttrMin.high)} min, ` +
      `the illustrative gain is between ${formatForNarrative(m.minutesSaved.low)} and ${formatForNarrative(m.minutesSaved.high)} min.`,
    );
  }
  if (i.actions.length > 0) s.push(`Actions recorded in the incident: ${i.actions.length}.`);

  let root: string;
  if (!i.diagnosis) {
    root = "No conclusive diagnosis; the root cause remains open.";
  } else {
    const d = i.diagnosis;
    root = `Cause classified as ${CATEGORY_LABELS[d.category]} (${CONFIDENCE_LABELS[d.confidence]} confidence).`;
    // A hipótese vem do modelo: só entra se todos os números dela tiverem origem.
    if (checkNarrative(d.hypothesis, allowed).passed) root += ` Hypothesis: ${d.hypothesis.trim().replace(/[.;:]?$/, ".")}`;
    if (evidence.length > 0) root += ` Evidence: ${evidence.map((e) => e.summary).join("; ")}.`;
  }

  const prevention = PREVENTION[i.diagnosis?.category ?? "unknown"] ?? DEFAULT_PREVENTION;
  return { summary: truncate(s.join(" "), 800), rootCauseNarrative: truncate(root, 1200), prevention: [...prevention] };
}

const minutes = (n: number | null) => (n === null ? "not applicable" : `${fmtFixed(n, 1)} min`);
const rangeMin = (r: { low: number; high: number } | null) => (r === null ? "not applicable" : `${fmtFixed(r.low, 1)} to ${fmtFixed(r.high, 1)} min`);
const rangeUsd = (r: { low: number; high: number }) => `${usd(r.low)} to ${usd(r.high)}`;
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** "fake/scripted (postmortem.v1)" ou "openrouter · anthropic/x (postmortem.v1)": o provedor só aparece se o modelo não o traz. */
function narrativeSource(g: PostmortemDoc["generatedBy"]): string {
  if (g.model === "template") return "deterministic template";
  const model = g.model.startsWith(`${g.provider}/`) ? g.model : `${g.provider} · ${g.model}`;
  return `${model} (${g.promptVersion})`;
}

export function renderPostmortemMarkdown(doc: PostmortemDoc): string {
  const m = doc.metrics;
  const lines: string[] = [];
  lines.push(`# Post-mortem ${doc.incidentId}: ${doc.title}`, "");
  lines.push(`- Status: ${doc.status === "final" ? "final" : "partial"}`);
  lines.push(`- Service: ${doc.impact.service}`);
  lines.push(`- Narrative: ${narrativeSource(doc.generatedBy)}`);
  lines.push("- Blameless format: describes the system and the decisions, not people.", "");

  lines.push("## Summary", "", doc.summary, "");

  lines.push("## Timeline", "", "| Time (UTC) | Event |", "|---|---|");
  for (const t of doc.timeline) lines.push(`| ${t.ts.slice(0, 10)} ${clock(t.ts)} | ${cell(t.text)} |`);
  lines.push("");

  lines.push("## Root cause", "", `Category: ${CATEGORY_LABELS[doc.rootCause.category]}.`, "", doc.rootCause.narrative, "");
  if (doc.rootCause.evidence.length > 0) {
    lines.push("Evidence:", "");
    for (const e of doc.rootCause.evidence) lines.push(`- \`${e.ref}\`: ${e.summary}`);
    lines.push("");
  }

  lines.push("## Actions", "");
  if (doc.actions.length === 0) {
    lines.push("No actions recorded.", "");
  } else {
    lines.push("| Action | Tier | Status | Decided by |", "|---|---|---|---|");
    for (const a of doc.actions) lines.push(`| ${cell(a.actionType)} | ${a.tier} | ${ACTION_STATUS_LABELS[a.status]} | ${cell(a.decidedBy ?? "automatic")} |`);
    lines.push("");
  }

  lines.push("## Numbers", "");
  lines.push(`- MTTR: ${minutes(m.mttrMin)} (measured)`);
  lines.push(`- MTTD: ${minutes(m.mttdMin)} (measured)`);
  lines.push(`- Time waiting for approval: ${minutes(m.timeAwaitingApprovalMin)} (measured)`);
  lines.push(`- Monthly savings: ${usd(m.monthlySavingsUsd)} (derived from the inventory findings of the executed actions)`);
  lines.push(`- MTTR baseline: ${rangeMin(m.baselineMttrMin)} (synthetic assumption)`);
  lines.push(`- Minutes saved: ${rangeMin(m.minutesSaved)} (illustrative, synthetic baseline)`);
  lines.push(`- Downtime cost avoided: ${rangeUsd(m.downtimeCostAvoidedUsd)} (illustrative)`);
  lines.push(`- Engineering cost saved: ${rangeUsd(m.engineeringCostSavedUsd)} (illustrative)`);
  lines.push(`- Copilot cost per incident: ${usd(m.copilotCostUsd)} (derived)`);
  lines.push(`- ROI: ${m.roiIllustrative === null ? "not applicable" : `${fmtFixed(m.roiIllustrative.low, 1)}x to ${fmtFixed(m.roiIllustrative.high, 1)}x`} (illustrative, synthetic baseline)`);
  lines.push(`- LLM: ${m.llmCalls} calls, ${m.promptTokens} input tokens, ${m.completionTokens} output tokens, ${usd(m.llmCostUsd)} (measured)`);
  lines.push(`- Assumptions: version ${m.assumptionsVersion}`, "");

  lines.push("## Prevention", "");
  for (const p of doc.prevention) lines.push(`- ${p}`);
  lines.push("");

  if (doc.escalation) {
    lines.push("## Escalation", "", `${ESCALATION_LABELS[doc.escalation.reason]}: ${doc.escalation.detail}`, "");
  }

  lines.push("## Numeric guard", "");
  lines.push(doc.numericGuard.passed ? "- Every number in the narrative has a calculated source." : `- Numbers without a source rejected: ${doc.numericGuard.rejectedNumbers.join(", ")}`);
  lines.push(`- Template used: ${doc.numericGuard.usedTemplate ? "yes" : "no"}`, "");
  return lines.join("\n");
}
