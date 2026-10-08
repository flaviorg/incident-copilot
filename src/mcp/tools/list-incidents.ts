// Tool list_incidents (spec 5.4): incidentes recentes, com filtro e LIMIT em SQL.
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Container } from "../../app/container.ts";
import { IncidentStatusSchema, IncidentSummarySchema } from "../../contracts/index.ts";
import { toolError, toolOk } from "../tool-result.ts";

const ListIncidentsInput = {
  status: IncidentStatusSchema.optional().describe("Filtra pelo status do incidente"),
  service: z.string().min(1).max(60).optional().describe("Filtra pelo serviço, ex.: orders-api"),
  limit: z.number().int().min(1).max(50).default(10).describe("Quantos incidentes, do mais recente ao mais antigo (1 a 50)"),
};
const ListIncidentsOutputSchema = z.object({ incidents: z.array(IncidentSummarySchema) });

export function registerListIncidents(server: McpServer, c: Container): void {
  server.registerTool(
    "list_incidents",
    {
      title: "Listar incidentes",
      description: "Use para ver incidentes recentes e seus status antes de investigar ou propor algo.",
      inputSchema: ListIncidentsInput,
      outputSchema: ListIncidentsOutputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async ({ status, service, limit }) => {
      try {
        const incidents = c.incidents.list({ limit, ...(status ? { status } : {}), ...(service ? { service } : {}) });
        const text = incidents.length === 0
          ? "nenhum incidente encontrado"
          : `${incidents.length} incidente(s): ${incidents.map((i) => `${i.id} ${i.status} (${i.service ?? i.scenarioId})`).join("; ")}`;
        return toolOk(c, ListIncidentsOutputSchema, { incidents }, text);
      } catch (e) {
        return toolError(c, e, "list_incidents");
      }
    },
  );
}
