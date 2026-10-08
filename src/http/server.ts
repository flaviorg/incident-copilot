// Servidor Fastify (spec 4.4, 5.3 e 6.9) sem listen: os testes usam app.inject. Toda resposta leva X-Request-Id e todo
// corpo em texto passa por redactSecrets no onSend. Erros tipados viram status pelo toHttpError; o inesperado vira 500
// genérico e o detalhe vai só para o log em stderr. Portas falam só com a aplicação (container).
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Container } from "../app/container.ts";
import { redactSecrets } from "../infra/redact.ts";
import { requestIdFrom } from "./request-id.ts";
import { toHttpError } from "./errors.ts";
import { registerHealthRoutes } from "./routes/health.ts";
import { registerScenarioRoutes } from "./routes/scenarios.ts";
import { registerIncidentRoutes } from "./routes/incidents.ts";
import { registerApprovalRoutes } from "./routes/approvals.ts";
import { registerStatsRoutes } from "./routes/stats.ts";

/** Corpo HTTP máximo (spec 6.2). */
const BODY_LIMIT_BYTES = 65_536;

const clipText = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max - 1) + "…");

export function buildServer(c: Container): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: BODY_LIMIT_BYTES,
    requestIdHeader: false,
    genReqId: (req) => requestIdFrom(req.headers["x-request-id"]),
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-request-id", req.id);
    return typeof payload === "string" ? redactSecrets(payload, c.secrets) : payload;
  });

  app.addHook("onResponse", async (req, reply) => {
    c.logger.info("requisição atendida", {
      requestId: req.id, method: req.method, url: clipText(req.url, 200), statusCode: reply.statusCode, latencyMs: Math.round(reply.elapsedTime),
    });
  });

  app.setErrorHandler((err, req, reply) => {
    const { status, body, unexpected } = toHttpError(err, req.id);
    if (unexpected) {
      const e = err as { name?: unknown; message?: unknown };
      c.logger.error("erro inesperado na requisição", {
        requestId: req.id, method: req.method, url: clipText(req.url, 200), error: typeof e?.name === "string" ? e.name : "Error",
        detail: typeof e?.message === "string" ? clipText(e.message, 500) : null,
      });
    }
    return reply.code(status).type("application/json; charset=utf-8").send(body);
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: { code: "route_not_found", message: `rota não encontrada: ${req.method} ${clipText(req.url.split("?")[0] ?? "", 100)}`, requestId: req.id } }),
  );

  registerHealthRoutes(app, c);
  registerScenarioRoutes(app, c);
  registerIncidentRoutes(app, c);
  registerApprovalRoutes(app, c);
  registerStatsRoutes(app, c);
  return app;
}
