// Interface texts (spec 4.6 and 10.2). Status, category and escalation labels come from the backend domain,
// the same source as the post-mortem; the interface agent names and en-US formatting (display only) live here.
import type { AgentId, ApprovalStatus, IncidentStatus, Tier, TraceEvent, TraceType } from "@contracts";

export { ACTION_STATUS_LABELS, CATEGORY_LABELS, CONFIDENCE_LABELS, ESCALATION_LABELS } from "@domain/report/postmortem-template.ts";

/** "Interface name" column of the specialists table (spec 4.6). */
export const AGENT_NAMES: Record<AgentId, string> = {
  supervisor: "Supervisor",
  telemetry_analyst: "Telemetry analyst",
  runbook_retriever: "Runbook retriever",
  remediation_planner: "Remediation planner",
  auditor: "Plan auditor",
  gate: "Remediation gate",
  executor: "Executor",
  verifier: "Verifier (canary)",
  reporter: "Reporter",
  human: "Human",
  system: "Escalation",
  mcp_client: "MCP client",
  code_fixer: "Code fixer",
};

/** Who holds the authority behind an event: the thesis of the War Room, shown as the strip holder colour. */
export type Authority = "model" | "code" | "human" | "system";

export const AUTHORITY_LABELS: Record<Authority, string> = {
  model: "model proposes",
  code: "code decides",
  human: "human decides",
  system: "system",
};

/** Role line under each agent name: what that agent is allowed to do. */
export const AGENT_ROLES: Record<AgentId, string> = {
  supervisor: "model · routes",
  telemetry_analyst: "model · investigates",
  runbook_retriever: "code · BM25 search",
  remediation_planner: "model · proposes",
  auditor: "model + rules · reviews",
  gate: "code · catalog tiers",
  executor: "code · runs actions",
  verifier: "code · canary",
  reporter: "model · writes",
  human: "human · decides",
  system: "code · escalates",
  mcp_client: "external client",
  code_fixer: "model + code · proposes a fix",
};

const AGENT_AUTHORITY: Record<AgentId, Authority> = {
  supervisor: "model",
  telemetry_analyst: "model",
  runbook_retriever: "code",
  remediation_planner: "model",
  auditor: "model",
  gate: "code",
  executor: "code",
  verifier: "code",
  reporter: "model",
  human: "human",
  system: "code",
  mcp_client: "system",
  code_fixer: "model",
};

/** Deterministic critics (guards, gate, canary) are code even when another agent emits them. */
export function authorityOf(e: TraceEvent): Authority {
  if (e.type === "critique" && e.payload.by !== "auditor") return "code";
  return AGENT_AUTHORITY[e.agent];
}

export const TIER_LABELS: Record<Tier, string> = {
  1: "decides alone (read-only)",
  2: "decides and logs",
  3: "requires human approval",
  4: "forbidden by construction",
};

export const TRACE_TYPE_LABELS: Record<TraceType, string> = {
  thought: "thought",
  action: "action",
  observation: "observation",
  plan: "plan",
  critique: "critique",
  answer: "answer",
  handoff: "handoff",
};

export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = { pending: "pending", approved: "approved", rejected: "rejected", expired: "expired" };

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  open: "open",
  investigating: "investigating",
  awaiting_approval: "awaiting approval",
  mitigating: "mitigating",
  resolved: "resolved",
  escalated: "escalated",
  advised: "advised",
};

export const SOURCE_LABELS = { measured: "measured", assumption: "assumption", derived: "derived" } as const;

export const CRITIC_LABELS = { auditor: "auditor", supervisor_guard: "supervisor guard", gate: "gate", numeric_guard: "numeric guard", canary: "canary" } as const;

export const VERDICT_LABELS = { approve: "approved", revise: "revise", reject: "rejected", coerced: "coerced", blocked: "blocked" } as const;

export const ANSWER_LABELS = { diagnosis: "diagnosis", postmortem: "post-mortem", escalation: "escalation" } as const;

const number = (digits: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Number with fixed decimals in en-US (display only; values come ready from the recording). */
export function formatNumber(n: number, digits = 1): string {
  return number(digits).format(n);
}

export function formatUsd(n: number): string {
  return `US$ ${number(2).format(n)}`;
}

/** Time of the recorded timeline (UTC, simulated clock), HH:MM:SS. */
export function formatTime(iso: string): string {
  return iso.slice(11, 19);
}
