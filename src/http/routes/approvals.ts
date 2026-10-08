// Rotas de aprovações (spec 5.3 e 6.5). O token vem do cabeçalho X-Approval-Token e é conferido pelo ApprovalService,
// que também valida o corpo primeiro (ordem do spec 6.5: corpo, token configurado, bloqueio, token, texto ambíguo...).
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
    // O serviço valida o corpo com DecisionBodySchema antes de olhar o token.
    return c.approvals.decide(id, (req.body ?? {}) as DecisionBody, singleHeader(req.headers["x-approval-token"]), { requestId: req.id });
  });
}
