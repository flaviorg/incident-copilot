// Textos da interface (spec 4.6 e 10.2). Os rótulos de status, categoria e escalonamento vêm do domínio do backend,
// a mesma fonte do post-mortem; aqui ficam os nomes de agente da interface e a formatação en-US (só exibição).
import type { AgentId, ApprovalStatus, IncidentStatus, Tier, TraceType } from "@contracts";

export { ACTION_STATUS_LABELS, CATEGORY_LABELS, CONFIDENCE_LABELS, ESCALATION_LABELS } from "@domain/report/postmortem-template.ts";

/** "Nome na interface" da tabela de especialistas (spec 4.6). */
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
};

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
};

export const SOURCE_LABELS = { measured: "measured", assumption: "assumption", derived: "derived" } as const;

export const CRITIC_LABELS = { auditor: "auditor", supervisor_guard: "supervisor guard", gate: "gate", numeric_guard: "numeric guard", canary: "canary" } as const;

export const VERDICT_LABELS = { approve: "approved", revise: "revise", reject: "rejected", coerced: "coerced", blocked: "blocked" } as const;

export const ANSWER_LABELS = { diagnosis: "diagnosis", postmortem: "post-mortem", escalation: "escalation" } as const;

const number = (digits: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Número com casas fixas em en-US (só exibição; os valores vêm prontos da gravação). */
export function formatNumber(n: number, digits = 1): string {
  return number(digits).format(n);
}

export function formatUsd(n: number): string {
  return `US$ ${number(2).format(n)}`;
}

/** Horário da linha do tempo gravada (UTC, relógio simulado), HH:MM:SS. */
export function formatTime(iso: string): string {
  return iso.slice(11, 19);
}
