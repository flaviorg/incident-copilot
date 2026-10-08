// Tool get_incident (spec 5.4): IncidentView e os `traceLimit` eventos mais recentes do trace, em ordem de seq.
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Container } from "../../app/container.ts";
import { IncidentViewSchema, TraceEventSchema, TraceTypeSchema } from "../../contracts/index.ts";
import { toolError, toolOk } from "../tool-result.ts";

const GetIncidentInput = {
  incidentId: z.string().min(1).max(64).describe("Incident id, e.g. INC-0001"),
  traceLimit: z.number().int().min(0).max(50).default(20).describe("How many of the most recent trace events (0 to 50)"),
  traceTypes: z.array(TraceTypeSchema).max(7).optional().describe("Only these trace event types"),
};
const GetIncidentOutputSchema = z.object({ incident: IncidentViewSchema, trace: z.array(TraceEventSchema) });

export function registerGetIncident(server: McpServer, c: Container): void {
  server.registerTool(
    "get_incident",
    {
      title: "Read incident",
      description: "Use to read the diagnosis, plan, actions by tier, metrics and the most recent trace events of an incident.",
      inputSchema: GetIncidentInput,
      outputSchema: GetIncidentOutputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async ({ incidentId, traceLimit, traceTypes }) => {
      try {
        const incident = c.incidents.get(incidentId);
        const trace = c.incidents.trace(incidentId, { last: traceLimit, ...(traceTypes ? { types: traceTypes } : {}) });
        const i = incident.incident;
        const byTier = [2, 3, 4].map((t) => `tier ${t}: ${incident.actions.filter((a) => a.tier === t).length}`).join(", ");
        const text = [
          `${i.id} ${i.status} · ${i.service ?? i.scenarioId} · ${i.severity}`,
          incident.diagnosis ? `diagnosis ${incident.diagnosis.category} (${incident.diagnosis.confidence} confidence)` : "no diagnosis",
          `${incident.actions.length} ${incident.actions.length === 1 ? "action" : "actions"} (${byTier})`,
          `${trace.length} of ${incident.traceCount} trace ${incident.traceCount === 1 ? "event" : "events"}`,
        ].join(" · ");
        return toolOk(c, GetIncidentOutputSchema, { incident, trace }, text);
      } catch (e) {
        return toolError(c, e, "get_incident");
      }
    },
  );
}
