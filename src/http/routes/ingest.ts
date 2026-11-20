// Webhook ingest (spec 008; AC-42 to AC-45). An encapsulated plugin: its only body parser keeps the raw bytes, so the
// connector verifies signatures on exactly what the provider sent. Answers 202 fast; the run happens on the queue.
// API_TOKEN does not apply here (server.ts): each connector authenticates with its own scheme.
import * as z from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Container } from "../../app/container.ts";
import type { IngestRejectionCode } from "../../app/ingest-service.ts";
import type { InboundRequest } from "../../connectors/types.ts";

export const DEFAULT_INGEST_BODY_LIMIT = 1_048_576;

const ParamsSchema = z.object({ connectorId: z.string().min(1).max(64), token: z.string().min(1).max(256).optional() });

/** Generic texts: a rejection says what kind of problem it was, never why in detail (no echo of the body or credentials). */
const MESSAGES: Record<IngestRejectionCode, string> = {
  invalid_payload: "the payload is not valid for this connector",
  invalid_webhook_credentials: "invalid or missing webhook credentials",
  connector_not_found: "no ingest connector with this id",
  ingest_rate_limited: "too many webhooks for this connector; retry later",
  ingest_queue_full: "the alert queue is full; retry later",
};

function headersOf(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const first = Array.isArray(v) ? v[0] : v;
    if (typeof first === "string") out[k.toLowerCase()] = first;
  }
  return out;
}

export function registerIngestRoutes(app: FastifyInstance, c: Container): void {
  const bodyLimit = c.copilot?.ingest.maxBodyBytes ?? DEFAULT_INGEST_BODY_LIMIT;
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
      const params = ParamsSchema.safeParse(req.params);
      if (!params.success) {
        return reply.code(404).send({ error: { code: "connector_not_found", message: MESSAGES.connector_not_found, requestId: req.id } });
      }
      const inbound: InboundRequest = {
        connectorId: params.data.connectorId,
        requestId: req.id,
        receivedAt: c.clock.now(),
        headers: headersOf(req),
        rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        pathToken: params.data.token ?? null,
        remoteAddress: req.ip,
      };
      const r = c.ingest.receive(params.data.connectorId, inbound);
      if (r.kind === "rejected") {
        if (r.retryAfterSec !== undefined) void reply.header("retry-after", String(r.retryAfterSec));
        return reply.code(r.status).send({ error: { code: r.code, message: MESSAGES[r.code], requestId: req.id } });
      }
      return reply.code(202).send({ accepted: r.accepted, duplicates: r.duplicates, ignored: r.ignored, alertIds: r.alertIds, requestId: req.id });
    };

    scope.post("/ingest/:connectorId", { bodyLimit }, handler);
    scope.post("/ingest/:connectorId/:token", { bodyLimit }, handler);
  });
}
