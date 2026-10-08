// Rotas de incidentes (spec 5.3). Corpo, params e query passam por parseOr400; regras e erros vêm do IncidentService.
import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.ts";
import { CreateIncidentBodySchema, ListIncidentsQuerySchema, PostmortemQuerySchema, TraceQuerySchema } from "../../contracts/index.ts";
import { parseOr400 } from "../errors.ts";
import { IdParamsSchema } from "./params.ts";

export function registerIncidentRoutes(app: FastifyInstance, c: Container): void {
  app.post("/incidents", async (req, reply) => {
    const body = parseOr400(CreateIncidentBodySchema, req.body ?? {});
    const view = await c.incidents.open(body, { requestId: req.id });
    return reply.code(201).send(view);
  });

  app.get("/incidents", async (req) => {
    const q = parseOr400(ListIncidentsQuerySchema, req.query);
    return c.incidents.list({ limit: q.limit, ...(q.status ? { status: q.status } : {}), ...(q.service ? { service: q.service } : {}) });
  });

  app.get("/incidents/:id", async (req) => c.incidents.get(parseOr400(IdParamsSchema, req.params).id));

  app.get("/incidents/:id/trace", async (req) => {
    const { id } = parseOr400(IdParamsSchema, req.params);
    const q = parseOr400(TraceQuerySchema, req.query);
    return c.incidents.trace(id, { ...(q.type ? { type: q.type } : {}), ...(q.agent ? { agent: q.agent } : {}), ...(q.limit ? { limit: q.limit } : {}) });
  });

  app.get("/incidents/:id/audit", async (req) => c.incidents.audit(parseOr400(IdParamsSchema, req.params).id));

  app.get("/incidents/:id/postmortem", async (req, reply) => {
    const { id } = parseOr400(IdParamsSchema, req.params);
    const { format } = parseOr400(PostmortemQuerySchema, req.query);
    if (format === "json") return c.incidents.postmortem(id);
    return reply.type("text/markdown; charset=utf-8").send(c.incidents.postmortemMarkdown(id));
  });
}
