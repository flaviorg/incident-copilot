// GET /health (spec 5.3): provedor ativo e versão; nenhum erro previsto.
import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.ts";
import { APP_VERSION } from "../../infra/app-info.ts";

export function registerHealthRoutes(app: FastifyInstance, c: Container): void {
  app.get("/health", async () => ({ status: "ok", provider: c.config.llmProvider, version: APP_VERSION }));
}
