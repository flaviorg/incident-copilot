// Approval routes (spec 5.3 and 6.5). The token comes from the X-Approval-Token header and is checked by the ApprovalService,
// which also validates the body first (spec 6.5 order: body, configured token, lockout, token, ambiguous text...).
import type { FastifyInstance } from "fastify";
import type { Container } from "../../app/container.ts";
import { ApprovalsQuerySchema } from "../../contracts/index.ts";
import type { DecisionBody } from "../../contracts/index.ts";
import { parseOr400 } from "../errors.ts";
import { IdParamsSchema, singleHeader } from "./params.ts";

export function registerApprovalRoutes(app: FastifyInstance, c: Container): void {
  app.get("/approvals", async (req) => c.approvals.list(parseOr400(ApprovalsQuerySchema, req.query).status));

  app.post("/approvals/:id/decision", async (req) => {
    const { id } = parseOr400(IdParamsSchema, req.params);
    // The service validates the body with DecisionBodySchema before looking at the token.
    return c.approvals.decide(id, (req.body ?? {}) as DecisionBody, singleHeader(req.headers["x-approval-token"]), { requestId: req.id });
  });
}
