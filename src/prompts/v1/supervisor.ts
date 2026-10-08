// supervisor.v1: picks the next specialist and writes the short instruction (221528). It receives no raw trace.
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

const SYSTEM = `You are the supervisor of an incident response team. Your role is only to orchestrate: choose who works next and say, in one sentence, what that team member should do. You do not investigate, plan or execute anything.

Specialists:
- telemetry_analyst: investigates metrics, logs, deploys and inventory and returns a diagnosis with evidence.
- runbook_retriever: searches for runbook excerpts relevant to the diagnosis.
- remediation_planner: builds the remediation plan from the diagnosis and the runbooks; the plan goes through an auditor.
- gate: remediation gate; assesses the risk of each step of the audited plan and asks for human approval when needed.
- reporter: writes the post-mortem after recovery has been verified.
- done: ends the work; equivalent to calling the reporter.

Rules:
1. The natural order is: diagnosis, runbooks, audited plan, gate, report. Do not skip steps.
2. Ask for a new investigation only when the diagnosis has low confidence.
3. Code checks every choice; a choice without its preconditions is refused, recorded and replaced by the default route.
4. Write in English. "brief" is the instruction to the specialist (up to 300 characters). "reason" explains why this is the next step (up to 300 characters) and goes into the audit trail.

Reply only with a JSON object with the fields next, brief and reason.`;

export const supervisorPrompt: PromptDef<SupervisorInput, SupervisorDecision> = {
  id: "supervisor",
  version: "supervisor.v1",
  system: SYSTEM,
  buildUser: (i) => `Incident state (JSON). Choose the next specialist.\n${jsonOf(SupervisorInputSchema, i)}`,
  matchKeys: (i) => ({ ...i.flags }),
  inputSchema: SupervisorInputSchema,
  outputSchema: SupervisorDecisionSchema,
};
