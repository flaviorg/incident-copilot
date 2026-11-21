// Read API of live mode (spec 008): configured connectors and recently ingested alerts. Behind API_TOKEN when set.
import * as z from "zod";
import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.ts";
import { parseOr400 } from "../errors.ts";

const AlertsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

export function registerConnectorRoutes(app: FastifyInstance, c: Container): void {
  app.get("/connectors", async () => ({ connectors: c.connectors.list() }));
  app.get("/ingest/alerts", async (req) => {
    const { limit } = parseOr400(AlertsQuerySchema, req.query);
    return { alerts: c.store.listIngestedAlerts({ limit }) };
  });
}
