// GET /stats?since=1h|24h|7d (spec 5.3; AC-33): agregações por SQL na janela pedida.
import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.ts";
import { StatsQuerySchema } from "../../contracts/index.ts";
import { parseOr400 } from "../errors.ts";

export function registerStatsRoutes(app: FastifyInstance, c: Container): void {
  app.get("/stats", async (req) => c.stats.get(parseOr400(StatsQuerySchema, req.query).since));
}
