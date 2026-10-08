// Tool get_incident (spec 5.4): IncidentView e os `traceLimit` eventos mais recentes do trace, em ordem de seq.
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Container } from "../../app/container.ts";
import { IncidentViewSchema, TraceEventSchema, TraceTypeSchema } from "../../contracts/index.ts";
import { toolError, toolOk } from "../tool-result.ts";

const GetIncidentInput = {
  incidentId: z.string().min(1).max(64).describe("Id do incidente, ex.: INC-0001"),
  traceLimit: z.number().int().min(0).max(50).default(20).describe("Quantos eventos mais recentes do trace (0 a 50)"),
  traceTypes: z.array(TraceTypeSchema).max(7).optional().describe("Só estes tipos de evento do trace"),
};
const GetIncidentOutputSchema = z.object({ incident: IncidentViewSchema, trace: z.array(TraceEventSchema) });

export function registerGetIncident(server: McpServer, c: Container): void {
  server.registerTool(
    "get_incident",
    {
      title: "Ler incidente",
      description: "Use para ler diagnóstico, plano, ações por faixa, métricas e os eventos mais recentes do trace de um incidente.",
      inputSchema: GetIncidentInput,
      outputSchema: GetIncidentOutputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async ({ incidentId, traceLimit, traceTypes }) => {
      try {
        const incident = c.incidents.get(incidentId);
        const trace = c.incidents.trace(incidentId, { last: traceLimit, ...(traceTypes ? { types: traceTypes } : {}) });
        const i = incident.incident;
        const byTier = [2, 3, 4].map((t) => `faixa ${t}: ${incident.actions.filter((a) => a.tier === t).length}`).join(", ");
        const text = [
          `${i.id} ${i.status} · ${i.service ?? i.scenarioId} · ${i.severity}`,
          incident.diagnosis ? `diagnóstico ${incident.diagnosis.category} (confiança ${incident.diagnosis.confidence})` : "sem diagnóstico",
          `${incident.actions.length} ação(ões) (${byTier})`,
          `${trace.length} de ${incident.traceCount} evento(s) do trace`,
        ].join(" · ");
        return toolOk(c, GetIncidentOutputSchema, { incident, trace }, text);
      } catch (e) {
        return toolError(c, e, "get_incident");
      }
    },
  );
}
