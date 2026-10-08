// Tool propose_remediation (spec 5.4; AC-35 e AC-36): passa pelo mesmo caminho do portão e nunca aprova nem executa.
// Não existe tool de aprovação, por construção.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Container } from "../../app/container.ts";
import { ProposeRemediationInputSchema, ProposeRemediationResultSchema } from "../../contracts/index.ts";
import { toolError, toolOk } from "../tool-result.ts";

const LABELS: Record<string, string> = { ready: "pronta, executa com o lote após as decisões humanas", awaiting_approval: "na fila de aprovação humana" };

/** Ator da auditoria: mcp_client:<nome informado pelo cliente no initialize>, com caracteres seguros e no máximo 60. */
function mcpActor(clientName: string | undefined): string {
  const safe = (clientName ?? "").replace(/[^A-Za-z0-9._ -]/g, "").trim().slice(0, 60);
  return `mcp_client:${safe || "desconhecido"}`;
}

export function registerProposeRemediation(server: McpServer, c: Container): void {
  server.registerTool(
    "propose_remediation",
    {
      title: "Propor remediação",
      description:
        "Use para propor uma ação de remediação para um incidente aguardando aprovação. Faixa 2 entra no lote pronto; faixa 3 entra na fila de aprovação humana; faixa 4 e tipos fora do catálogo são recusados. Esta tool nunca aprova nem executa.",
      inputSchema: ProposeRemediationInputSchema.shape,
      outputSchema: ProposeRemediationResultSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      try {
        const r = c.incidents.proposeExternalAction(args, mcpActor(server.server.getClientVersion()?.name));
        const text = `${r.actionId} ${args.actionType} faixa ${r.tier}: ${LABELS[r.status] ?? r.status}${r.approvalId ? ` (${r.approvalId})` : ""}`;
        return toolOk(c, ProposeRemediationResultSchema, r, text);
      } catch (e) {
        return toolError(c, e, "propose_remediation");
      }
    },
  );
}
