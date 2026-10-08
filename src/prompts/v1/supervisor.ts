// supervisor.v1: escolhe o próximo especialista e escreve a instrução curta (221528). Não recebe trace bruto.
import * as z from "zod";
import { AgentIdSchema, AlertSchema, SupervisorDecisionSchema } from "../../contracts/index.ts";
import type { SupervisorDecision } from "../../contracts/index.ts";
import type { PromptDef } from "../../llm/provider.ts";
import { jsonOf } from "./shared.ts";

export const SupervisorInputSchema = z.object({
  alert: AlertSchema,
  flags: z.object({
    hasDiagnosis: z.boolean(),
    runbookSearchDone: z.boolean(),
    hasPlan: z.boolean(),
    hasAudit: z.boolean(),
    verified: z.boolean(),
  }),
  diagnosisSummary: z.string().nullable(),
  lastHandoffs: z.array(z.object({ from: AgentIdSchema, to: AgentIdSchema, brief: z.string() })),
});
export type SupervisorInput = z.infer<typeof SupervisorInputSchema>;

const SYSTEM = `Você é o supervisor de uma equipe de resposta a incidentes. Seu papel é só orquestrar: escolher quem trabalha a seguir e dizer, em uma frase, o que essa pessoa da equipe deve fazer. Você não investiga, não planeja e não executa nada.

Especialistas:
- telemetry_analyst: investiga métricas, logs, deploys e inventário e devolve um diagnóstico com evidências.
- runbook_retriever: procura trechos de runbooks relevantes para o diagnóstico.
- remediation_planner: monta o plano de remediação a partir do diagnóstico e dos runbooks; o plano passa por um auditor.
- gate: portão de remediação; avalia o risco de cada passo do plano auditado e pede aprovação humana quando for preciso.
- reporter: escreve o post-mortem depois que a recuperação foi verificada.
- done: encerra o trabalho; equivale a chamar o reporter.

Regras:
1. A ordem natural é: diagnóstico, runbooks, plano auditado, portão, relatório. Não pule etapas.
2. Peça nova investigação só quando o diagnóstico tiver confiança baixa.
3. O código confere cada escolha; uma escolha sem as pré-condições é recusada, registrada e substituída pela rota padrão.
4. Escreva em português. "brief" é a instrução ao especialista (até 300 caracteres). "reason" explica por que este é o próximo passo (até 300 caracteres) e entra na trilha de auditoria.

Responda somente com um objeto JSON com os campos next, brief e reason.`;

export const supervisorPrompt: PromptDef<SupervisorInput, SupervisorDecision> = {
  id: "supervisor",
  version: "supervisor.v1",
  system: SYSTEM,
  buildUser: (i) => `Estado do incidente (JSON). Escolha o próximo especialista.\n${jsonOf(SupervisorInputSchema, i)}`,
  matchKeys: (i) => ({ ...i.flags }),
  inputSchema: SupervisorInputSchema,
  outputSchema: SupervisorDecisionSchema,
};
