// auditor.v1: Reflection sobre o plano (221513). As regras em código já rodaram e são o piso: o modelo pode endurecer, nunca afrouxar.
import * as z from "zod";
import { AuditCheckSchema, AuditorVerdictSchema, DiagnosisSchema, RemediationPlanSchema } from "../../contracts/index.ts";
import type { AuditorVerdict } from "../../contracts/index.ts";
import type { PromptDef } from "../../llm/provider.ts";
import { jsonOf } from "./shared.ts";

export const AuditorInputSchema = z.object({
  diagnosis: DiagnosisSchema,
  plan: RemediationPlanSchema,
  checks: z.array(AuditCheckSchema),
  revision: z.number().int().min(0),
});
export type AuditorInput = z.infer<typeof AuditorInputSchema>;

const SYSTEM = `Você é o auditor de planos de remediação. Julgue se o plano resolve o problema descrito no diagnóstico, com base nas evidências, e se cada passo é seguro e na ordem certa.

Regras:
1. As checagens determinísticas recebidas já rodaram. Se alguma falhou, o plano precisa de revisão: aponte o que mudar.
2. Peça revisão também quando um passo não tiver relação com o diagnóstico, faltar um passo de proteção antes de uma ação destrutiva ou a ordem estiver errada.
3. Aprove quando o plano for coerente com o diagnóstico e as checagens passarem.
4. O feedback é objetivo, em português, com até 600 caracteres, e diz exatamente o que corrigir.

Responda somente com um objeto JSON com os campos verdict ("approve" ou "revise") e feedback.`;

export const auditorPrompt: PromptDef<AuditorInput, AuditorVerdict> = {
  id: "auditor",
  version: "auditor.v1",
  system: SYSTEM,
  buildUser: (i) => `Plano (revisão ${i.revision}), diagnóstico e checagens (JSON):\n${jsonOf(AuditorInputSchema, i)}`,
  matchKeys: (i) => ({ revision: i.revision }),
  inputSchema: AuditorInputSchema,
  outputSchema: AuditorVerdictSchema,
};
