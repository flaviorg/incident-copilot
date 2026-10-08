// Textos da interface (spec 4.6 e 10.2). Os rótulos de status, categoria e escalonamento vêm do domínio do backend,
// a mesma fonte do post-mortem; aqui ficam os nomes de agente da interface e a formatação pt-BR (só exibição).
import type { AgentId, ApprovalStatus, IncidentStatus, Tier, TraceType } from "@contracts";

export { ACTION_STATUS_LABELS, CATEGORY_LABELS, CONFIDENCE_LABELS, ESCALATION_LABELS } from "@domain/report/postmortem-template.ts";

/** "Nome na interface" da tabela de especialistas (spec 4.6). */
export const AGENT_NAMES: Record<AgentId, string> = {
  supervisor: "Supervisor",
  telemetry_analyst: "Analista de telemetria",
  runbook_retriever: "Recuperador de runbooks",
  remediation_planner: "Planejador de remediação",
  auditor: "Auditor de plano",
  gate: "Portão de remediação",
  executor: "Executor",
  verifier: "Verificador (canário)",
  reporter: "Relator",
  human: "Humano",
  system: "Escalonamento",
  mcp_client: "Cliente MCP",
};

export const TIER_LABELS: Record<Tier, string> = {
  1: "decide sozinho (leitura)",
  2: "decide e registra",
  3: "exige aprovação humana",
  4: "proibida por construção",
};

export const TRACE_TYPE_LABELS: Record<TraceType, string> = {
  thought: "pensamento",
  action: "ação",
  observation: "observação",
  plan: "plano",
  critique: "crítica",
  answer: "resposta",
  handoff: "passagem",
};

export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = { pending: "pendente", approved: "aprovada", rejected: "rejeitada", expired: "expirada" };

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  open: "aberto",
  investigating: "investigando",
  awaiting_approval: "aguardando aprovação",
  mitigating: "mitigando",
  resolved: "resolvido",
  escalated: "escalado",
};

export const SOURCE_LABELS = { measured: "medido", assumption: "premissa", derived: "derivado" } as const;

export const CRITIC_LABELS = { auditor: "auditor", supervisor_guard: "guarda do supervisor", gate: "portão", numeric_guard: "guarda numérico", canary: "canário" } as const;

export const VERDICT_LABELS = { approve: "aprovado", revise: "revisar", reject: "reprovado", coerced: "coagido", blocked: "bloqueado" } as const;

export const ANSWER_LABELS = { diagnosis: "diagnóstico", postmortem: "post-mortem", escalation: "escalonamento" } as const;

const number = (digits: number) => new Intl.NumberFormat("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Número com casas fixas em pt-BR (só exibição; os valores vêm prontos da gravação). */
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
