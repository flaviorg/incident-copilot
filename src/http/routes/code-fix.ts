// Code-fix route (spec 009, HTTP table; AC-74, AC-79): the latest attempt of an incident as a redacted view, with the
// patch and without the post-images. Behind API_TOKEN like every other route (server.ts onRequest hook).
import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.ts";
import { toCodeFixView } from "../../app/views.ts";
import { parseOr400 } from "../errors.ts";
import { IdParamsSchema } from "./params.ts";

export function registerCodeFixRoutes(app: FastifyInstance, c: Container): void {
  app.get("/incidents/:id/code-fix", async (req) => {
    const { id } = parseOr400(IdParamsSchema, req.params);
    // Code-fix expiry is materialized on read (spec 009, decision 14), so the view shows an overdue attempt as expired.
    c.codeFix?.listApprovals({ requestId: req.id });
    return toCodeFixView(c.incidents.codeFixAttempt(id), c.secrets);
  });
}
