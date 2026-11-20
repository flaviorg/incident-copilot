// Incident routes (spec 5.3). Body, params and query go through parseOr400; rules and errors come from IncidentService.
import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.ts";
import { CreateIncidentBodySchema, ListIncidentsQuerySchema, PostmortemQuerySchema, TraceQuerySchema } from "../../contracts/index.ts";
import { parseOr400 } from "../errors.ts";
import { IdParamsSchema } from "./params.ts";

export function registerIncidentRoutes(app: FastifyInstance, c: Container, o: { maxConcurrentRuns: number }): void {
  // Review 2026-11: each POST /incidents runs the whole graph (real LLM calls with a key), so runs are capped. The slots
  // are shared with the live alert queue (spec 008, AC-48).
  const tooMany = (reqId: string) => ({ error: { code: "too_many_runs", message: `at most ${o.maxConcurrentRuns} incident run(s) at a time; retry later`, requestId: reqId } });
  const capped = async <T>(release: () => void, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } finally {
      release();
    }
  };

  app.post("/incidents", async (req, reply) => {
    const body = parseOr400(CreateIncidentBodySchema, req.body ?? {});
    const release = c.runSlots.tryAcquire();
    if (!release) return reply.code(429).send(tooMany(req.id));
    const view = await capped(release, () => c.incidents.open(body, { requestId: req.id }));
    return reply.code(201).send(view);
  });

  // Review 2026-11: retries a resume whose run failed (every approval decided, phase still "resume"). It only runs
  // what humans already approved, so it needs no token; 409 incident_not_accepting in any other phase.
  app.post("/incidents/:id/resume", async (req, reply) => {
    const { id } = parseOr400(IdParamsSchema, req.params);
    const release = c.runSlots.tryAcquire();
    if (!release) return reply.code(429).send(tooMany(req.id));
    return capped(release, () => c.incidents.resume(id, { requestId: req.id }));
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
