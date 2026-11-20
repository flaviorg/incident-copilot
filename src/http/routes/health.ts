// GET /health (spec 5.3): active provider and version; no errors expected.
import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.ts";
import { APP_VERSION } from "../../infra/app-info.ts";

export function registerHealthRoutes(app: FastifyInstance, c: Container): void {
  app.get("/health", async () => ({ status: "ok", provider: c.config.llmProvider, version: APP_VERSION }));
}
