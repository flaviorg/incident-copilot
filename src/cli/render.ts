// Formatação de saída da CLI (texto para pessoas, em pt-BR).
import type { ToolResult } from "../tools/registry.ts";
import type { IncidentMetrics, TraceEvent } from "../contracts/index.ts";
import { AGENT_LABELS } from "../domain/report/postmortem-template.ts";

/** Tabela com colunas alinhadas por espaços. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export function renderToolResult(o: { name: string; scenarioId: string; now: string; result: ToolResult }): string {
  const r = o.result;
  return [
    `ferramenta: ${o.name} (faixa 1, só leitura) | cenário: ${o.scenarioId} | agora: ${o.now}`,
    `ok: ${r.ok ? "sim" : "não"}`,
    r.summary,
    `evidência: ${r.evidenceRef ?? "nenhuma"}`,
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
  approve: "aprovado", revise: "pede revisão", reject: "reprovado", coerced: "escolha corrigida", blocked: "bloqueado",
};
const CRITIC_LABELS: Record<string, string> = {
  auditor: "auditor", supervisor_guard: "guarda do supervisor", gate: "portão", numeric_guard: "guarda numérico", canary: "canário",
};

/** Uma linha por evento no formato do spec 10.3: horário, recuo de 2 espaços para conversa e de 4 para passos. */
export function renderEvent(e: TraceEvent): string | null {
  const t = time(e.ts);
  switch (e.type) {
    case "handoff":
      return `${t}  ${AGENT_LABELS[e.payload.from]} → ${AGENT_LABELS[e.payload.to]}: ${oneLine(e.payload.brief)}`;
    case "thought":
      return `${t}    pensa ${oneLine(e.payload.text)}`;
    case "action":
      return `${t}    ação  ${e.payload.tool}(${oneLine(argValues(e.payload.args), 160)})${e.payload.tier === null ? "" : ` · faixa ${e.payload.tier}`}`;
    case "observation":
      // No portão, ok=false quer dizer "não passou no portão" (o resumo já diz por quê), não falha de ferramenta.
      return `${t}    obs   ${e.payload.ok || e.agent === "gate" ? "" : "falhou: "}${oneLine(e.payload.summary)}`;
    case "plan":
      return `${t}  ${AGENT_LABELS[e.agent]}: plano revisão ${e.payload.revision} com ${e.payload.steps.length} passo${e.payload.steps.length === 1 ? "" : "s"}: ${oneLine(e.payload.summary, 160)}`;
    case "critique":
      return `${t}  ${CRITIC_LABELS[e.payload.by] ?? e.payload.by}: ${VERDICT_LABELS[e.payload.verdict] ?? e.payload.verdict} (${oneLine(e.payload.feedback, 200)})`;
    case "answer":
      return `${t}  ${AGENT_LABELS[e.agent]}: ${oneLine(e.payload.text, 260)}`;
  }
}

const one = (x: number) => x.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const usd = (x: number) => `US$ ${x.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const times = (x: number) => `${x.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}x`;
const row = (label: string, value: string, note: string) => `${label.padEnd(24)}${value.padEnd(16)}${note}`;

/**
 * Quadro de números (spec 5.7 e 10.3): MTTR e tempo aguardando aprovação em destaque; minutos economizados e ROI como
 * faixa rotulada "ilustrativo"; economia mensal quando houver.
 */
export function renderMetrics(m: IncidentMetrics): string[] {
  const lines: string[] = [];
  lines.push(m.mttrMin === null
    ? row("MTTR", "não resolvido", "medido (incidente escalado, sem verificação saudável)")
    : row("MTTR", `${one(m.mttrMin)} min`, `medido (linha do tempo simulada, ${time(m.impactStartedAt)} → ${time(m.resolvedAt ?? m.detectedAt)})`));
  lines.push(row("  aguardando aprovação", `${one(m.timeAwaitingApprovalMin)} min`, "medido (soma das aprovações decididas)"));
  lines.push(row("MTTD", `${one(m.mttdMin)} min`, "medido"));
  if (m.monthlySavingsUsd > 0) lines.push(row("Economia mensal", usd(m.monthlySavingsUsd), "derivado (achados de inventário das ações executadas)"));
  if (m.minutesSaved) {
    lines.push(row("Minutos economizados", `${one(m.minutesSaved.low)} a ${one(m.minutesSaved.high)}`, `ilustrativo (linha de base sintética de ${m.baselineMttrMin.low} a ${m.baselineMttrMin.high} min)`));
  }
  if (m.roiIllustrative) {
    lines.push(row("ROI", `${times(m.roiIllustrative.low)} a ${times(m.roiIllustrative.high)}`, "ilustrativo (premissas em data/business-assumptions.json)"));
  }
  lines.push(row("Custo de LLM", usd(m.llmCostUsd), `medido (${m.llmCalls} chamadas, ${m.promptTokens + m.completionTokens} tokens)`));
  return lines;
}
