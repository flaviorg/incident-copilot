// GET /scenarios (spec 5.3): summary of the demo scenarios.
import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.ts";

export function registerScenarioRoutes(app: FastifyInstance, c: Container): void {
  app.get("/scenarios", async () => c.scenarios.list());
}
