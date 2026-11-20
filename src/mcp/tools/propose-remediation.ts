// propose_remediation tool (spec 5.4; AC-35 and AC-36): goes through the same path as the gate and never approves or executes.
// There is no approval tool, by construction.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Container } from "../../app/container.ts";
import { ProposeRemediationInputSchema, ProposeRemediationResultSchema } from "../../contracts/index.ts";
import { toolError, toolOk } from "../tool-result.ts";

const LABELS: Record<string, string> = { ready: "ready, runs with the batch after the human decisions", awaiting_approval: "in the human approval queue" };

/** Audit actor: mcp_client:<name given by the client in initialize>, with safe characters and at most 60. */
function mcpActor(clientName: string | undefined): string {
  const safe = (clientName ?? "").replace(/[^A-Za-z0-9._ -]/g, "").trim().slice(0, 60);
  return `mcp_client:${safe || "unknown"}`;
}

export function registerProposeRemediation(server: McpServer, c: Container): void {
  server.registerTool(
    "propose_remediation",
    {
      title: "Propose remediation",
      description:
        "Use to propose a remediation action for an incident awaiting approval. Tier 2 joins the ready batch; tier 3 joins the human approval queue; tier 4 and types not in the catalog are refused. This tool never approves or executes.",
      inputSchema: ProposeRemediationInputSchema.shape,
      outputSchema: ProposeRemediationResultSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      try {
        const r = c.incidents.proposeExternalAction(args, mcpActor(server.server.getClientVersion()?.name));
        const text = `${r.actionId} ${args.actionType} tier ${r.tier}: ${LABELS[r.status] ?? r.status}${r.approvalId ? ` (${r.approvalId})` : ""}`;
        return toolOk(c, ProposeRemediationResultSchema, r, text);
      } catch (e) {
        return toolError(c, e, "propose_remediation");
      }
    },
  );
}
