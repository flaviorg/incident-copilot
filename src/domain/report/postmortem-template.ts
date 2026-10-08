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
  bad_deploy: "deploy com defeito",
  resource_leak: "vazamento de recurso",
  capacity: "capacidade",
  cost_anomaly: "anomalia de custo",
  vulnerability: "vulnerabilidade",
  dependency_failure: "falha de dependência",
  config_error: "erro de configuração",
  unknown: "desconhecida",
};

/** Nome de cada agente na interface (spec 4.6). */
export const AGENT_LABELS: Record<AgentId, string> = {
  supervisor: "supervisor",
  telemetry_analyst: "analista de telemetria",
  runbook_retriever: "recuperador de runbooks",
  remediation_planner: "planejador de remediação",
  auditor: "auditor",
  gate: "portão de remediação",
  executor: "executor",
  verifier: "verificador",
  reporter: "relator",
  human: "humano",
  system: "sistema",
  mcp_client: "cliente MCP",
};

export const CONFIDENCE_LABELS: Record<Confidence, string> = { low: "baixa", medium: "média", high: "alta" };

export const ESCALATION_LABELS: Record<EscalationReason, string> = {
  team_cap_reached: "teto de iterações da equipe atingido",
  react_cap_low_confidence: "teto de passos do analista atingido com baixa confiança",
  low_confidence_diagnosis: "diagnóstico ainda com baixa confiança depois das rodadas permitidas",
  recursion_limit: "limite de recursão do grafo atingido",
  llm_unavailable: "LLM indisponível",
  timeout: "tempo de execução esgotado",
  mitigation_rejected: "mitigação rejeitada por humano",
  remediation_ineffective: "remediação ineficaz (canário reprovado)",
  throttled: "limite de execuções atingido",
  circuit_open: "circuit breaker aberto",
  no_executable_actions: "nenhuma ação executável",
};

export const ACTION_STATUS_LABELS: Record<ActionStatus, string> = {
  proposed: "proposta",
  blocked_forbidden: "bloqueada (proibida)",
  blocked_unknown: "bloqueada (fora do catálogo)",
  rejected_invalid_params: "recusada (parâmetros inválidos)",
  rejected_by_dry_run: "recusada pelo dry run",
  awaiting_approval: "aguardando aprovação",
  approved: "aprovada",
  rejected: "rejeitada",
  expired: "expirada",
  ready: "pronta",
  succeeded: "executada",
  failed: "falhou",
  throttled: "limitada (taxa de execução)",
  blocked_circuit_open: "bloqueada (circuit breaker aberto)",
  cancelled: "cancelada",
  reverted: "revertida",
};

const PREVENTION: Partial<Record<RootCauseCategory, string[]>> = {
  bad_deploy: [
    "Promover versões com rollout gradual e canário automático antes de atingir todas as réplicas.",
    "Cobrir com teste os campos opcionais lidos pelo código alterado no deploy.",
    "Manter a versão anterior pronta para rollback e deixar claro quem pode aprovar.",
  ],
  cost_anomaly: [
    "Marcar recursos com dono e data de revisão para evitar recursos órfãos.",
    "Rodar a auditoria de inventário toda semana e alertar quando o custo diário fugir da média.",
    "Criar snapshot antes de excluir volumes e nunca apagar backups para cortar custo.",
  ],
};
const DEFAULT_PREVENTION = [
  "Revisar os sinais que dispararam o alerta e ajustar limiares e painéis.",
  "Registrar o aprendizado deste incidente no runbook correspondente.",
];

const fmtFixed = (n: number, d: number) => new Intl.NumberFormat("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);

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
  return `Incidente escalado para humanos: ${ESCALATION_LABELS[e.reason]}${detail ? ` (${detail})` : ""}.`;
}

export function renderTemplateNarrative(i: TemplateInput): PostmortemNarrative {
  const m = i.metrics;
  const evidence = i.diagnosis?.evidence ?? [];
  const allowed = collectAllowedNumbers({ metrics: m, timeline: [], evidence, counts: [i.actions.length] });

  const s: string[] = [];
  if (i.escalation) {
    s.push(escalationSentence(i.escalation));
    s.push("Este relatório é parcial e foi gerado pelo template determinístico.");
  } else if (i.status === "final") {
    s.push("Incidente resolvido.");
  } else {
    s.push("Incidente ainda sem resolução; relatório parcial.");
  }
  s.push(`O impacto começou às ${clock(m.impactStartedAt)} UTC e foi detectado em ${formatForNarrative(m.mttdMin)} min.`);
  if (m.mttrMin !== null) {
    const waiting = m.timeAwaitingApprovalMin > 0 ? `, dos quais ${formatForNarrative(m.timeAwaitingApprovalMin)} min aguardando aprovação humana` : "";
    s.push(`A resolução levou ${formatForNarrative(m.mttrMin)} min desde o início do impacto (MTTR)${waiting}.`);
  }
  if (m.monthlySavingsUsd > 0) s.push(`Economia mensal calculada a partir das ações executadas: ${usd(m.monthlySavingsUsd)}.`);
  if (m.minutesSaved) {
    s.push(
      `Contra a linha de base sintética de ${formatForNarrative(m.baselineMttrMin.low)} a ${formatForNarrative(m.baselineMttrMin.high)} min, ` +
      `o ganho ilustrativo fica entre ${formatForNarrative(m.minutesSaved.low)} e ${formatForNarrative(m.minutesSaved.high)} min.`,
    );
  }
  if (i.actions.length > 0) s.push(`Ações registradas no incidente: ${i.actions.length}.`);

  let root: string;
  if (!i.diagnosis) {
    root = "Sem diagnóstico conclusivo; a causa raiz segue em aberto.";
  } else {
    const d = i.diagnosis;
    root = `Causa classificada como ${CATEGORY_LABELS[d.category]} (confiança ${CONFIDENCE_LABELS[d.confidence]}).`;
    // A hipótese vem do modelo: só entra se todos os números dela tiverem origem.
    if (checkNarrative(d.hypothesis, allowed).passed) root += ` Hipótese: ${d.hypothesis.trim().replace(/[.;:]?$/, ".")}`;
    if (evidence.length > 0) root += ` Evidências: ${evidence.map((e) => e.summary).join("; ")}.`;
  }

  const prevention = PREVENTION[i.diagnosis?.category ?? "unknown"] ?? DEFAULT_PREVENTION;
  return { summary: truncate(s.join(" "), 800), rootCauseNarrative: truncate(root, 1200), prevention: [...prevention] };
}

const minutes = (n: number | null) => (n === null ? "não se aplica" : `${fmtFixed(n, 1)} min`);
const rangeMin = (r: { low: number; high: number } | null) => (r === null ? "não se aplica" : `${fmtFixed(r.low, 1)} a ${fmtFixed(r.high, 1)} min`);
const rangeUsd = (r: { low: number; high: number }) => `${usd(r.low)} a ${usd(r.high)}`;
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** "fake/scripted (postmortem.v1)" ou "openrouter · anthropic/x (postmortem.v1)": o provedor só aparece se o modelo não o traz. */
function narrativeSource(g: PostmortemDoc["generatedBy"]): string {
  if (g.model === "template") return "template determinístico";
  const model = g.model.startsWith(`${g.provider}/`) ? g.model : `${g.provider} · ${g.model}`;
  return `${model} (${g.promptVersion})`;
}

export function renderPostmortemMarkdown(doc: PostmortemDoc): string {
  const m = doc.metrics;
  const lines: string[] = [];
  lines.push(`# Post-mortem ${doc.incidentId}: ${doc.title}`, "");
  lines.push(`- Status: ${doc.status === "final" ? "final" : "parcial"}`);
  lines.push(`- Serviço: ${doc.impact.service}`);
  lines.push(`- Narrativa: ${narrativeSource(doc.generatedBy)}`);
  lines.push("- Formato sem culpa: descreve o sistema e as decisões, não pessoas.", "");

  lines.push("## Resumo", "", doc.summary, "");

  lines.push("## Linha do tempo", "", "| Horário (UTC) | Evento |", "|---|---|");
  for (const t of doc.timeline) lines.push(`| ${t.ts.slice(0, 10)} ${clock(t.ts)} | ${cell(t.text)} |`);
  lines.push("");

  lines.push("## Causa raiz", "", `Categoria: ${CATEGORY_LABELS[doc.rootCause.category]}.`, "", doc.rootCause.narrative, "");
  if (doc.rootCause.evidence.length > 0) {
    lines.push("Evidências:", "");
    for (const e of doc.rootCause.evidence) lines.push(`- \`${e.ref}\`: ${e.summary}`);
    lines.push("");
  }

  lines.push("## Ações", "");
  if (doc.actions.length === 0) {
    lines.push("Nenhuma ação registrada.", "");
  } else {
    lines.push("| Ação | Faixa | Status | Decidido por |", "|---|---|---|---|");
    for (const a of doc.actions) lines.push(`| ${cell(a.actionType)} | ${a.tier} | ${ACTION_STATUS_LABELS[a.status]} | ${cell(a.decidedBy ?? "automático")} |`);
    lines.push("");
  }

  lines.push("## Números", "");
  lines.push(`- MTTR: ${minutes(m.mttrMin)} (medido)`);
  lines.push(`- MTTD: ${minutes(m.mttdMin)} (medido)`);
  lines.push(`- Tempo aguardando aprovação: ${minutes(m.timeAwaitingApprovalMin)} (medido)`);
  lines.push(`- Economia mensal: ${usd(m.monthlySavingsUsd)} (derivado dos achados de inventário das ações executadas)`);
  lines.push(`- Linha de base de MTTR: ${rangeMin(m.baselineMttrMin)} (premissa sintética)`);
  lines.push(`- Minutos economizados: ${rangeMin(m.minutesSaved)} (ilustrativo, linha de base sintética)`);
  lines.push(`- Custo de indisponibilidade evitado: ${rangeUsd(m.downtimeCostAvoidedUsd)} (ilustrativo)`);
  lines.push(`- Custo de engenharia economizado: ${rangeUsd(m.engineeringCostSavedUsd)} (ilustrativo)`);
  lines.push(`- Custo do copiloto por incidente: ${usd(m.copilotCostUsd)} (derivado)`);
  lines.push(`- ROI: ${m.roiIllustrative === null ? "não se aplica" : `${fmtFixed(m.roiIllustrative.low, 1)}x a ${fmtFixed(m.roiIllustrative.high, 1)}x`} (ilustrativo, linha de base sintética)`);
  lines.push(`- LLM: ${m.llmCalls} chamadas, ${m.promptTokens} tokens de entrada, ${m.completionTokens} de saída, ${usd(m.llmCostUsd)} (medido)`);
  lines.push(`- Premissas: versão ${m.assumptionsVersion}`, "");

  lines.push("## Prevenção", "");
  for (const p of doc.prevention) lines.push(`- ${p}`);
  lines.push("");

  if (doc.escalation) {
    lines.push("## Escalonamento", "", `${ESCALATION_LABELS[doc.escalation.reason]}: ${doc.escalation.detail}`, "");
  }

  lines.push("## Guarda numérico", "");
  lines.push(doc.numericGuard.passed ? "- Todos os números da narrativa têm origem calculada." : `- Números sem origem rejeitados: ${doc.numericGuard.rejectedNumbers.join(", ")}`);
  lines.push(`- Template usado: ${doc.numericGuard.usedTemplate ? "sim" : "não"}`, "");
  return lines.join("\n");
}
