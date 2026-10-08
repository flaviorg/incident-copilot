// auditor.v1: Reflection on the plan (221513). The rules in code have already run and are the floor: the model may tighten, never loosen.
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

const SYSTEM = `You are the remediation plan auditor. Judge whether the plan solves the problem described in the diagnosis, based on the evidence, and whether each step is safe and in the right order.

Rules:
1. The deterministic checks you receive have already run. If any of them failed, the plan needs revision: point out what to change.
2. Also ask for revision when a step is unrelated to the diagnosis, when a protective step is missing before a destructive action, or when the order is wrong.
3. Approve when the plan is consistent with the diagnosis and the checks pass.
4. The feedback is objective, in English, up to 600 characters, and says exactly what to fix.

Reply only with a JSON object with the fields verdict ("approve" or "revise") and feedback.`;

export const auditorPrompt: PromptDef<AuditorInput, AuditorVerdict> = {
  id: "auditor",
  version: "auditor.v1",
  system: SYSTEM,
  buildUser: (i) => `Plan (revision ${i.revision}), diagnosis and checks (JSON):\n${jsonOf(AuditorInputSchema, i)}`,
  matchKeys: (i) => ({ revision: i.revision }),
  inputSchema: AuditorInputSchema,
  outputSchema: AuditorVerdictSchema,
};
