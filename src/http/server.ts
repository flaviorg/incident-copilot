// Fastify server (spec 4.4, 5.3 and 6.9) without listen: tests use app.inject. Every response carries X-Request-Id and every
// text body goes through redactSecrets in onSend. Typed errors become a status through toHttpError; anything unexpected
// becomes a generic 500 and the detail goes only to the stderr log. Ports talk only to the application (container).
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Container } from "../app/container.ts";
import { redactSecrets, redactThenClip } from "../infra/redact.ts";
import { createHostGuard } from "./host-guard.ts";
import { constantTimeEqualsText } from "../infra/crypto.ts";
import { requestIdFrom } from "./request-id.ts";
import { toHttpError } from "./errors.ts";
import { registerHealthRoutes } from "./routes/health.ts";
import { registerScenarioRoutes } from "./routes/scenarios.ts";
import { registerIncidentRoutes } from "./routes/incidents.ts";
import { registerApprovalRoutes } from "./routes/approvals.ts";
import { registerStatsRoutes } from "./routes/stats.ts";
import { registerIngestRoutes } from "./routes/ingest.ts";
import { registerConnectorRoutes } from "./routes/connectors.ts";

/** Maximum HTTP body (spec 6.2). */
const BODY_LIMIT_BYTES = 65_536;


export function buildServer(c: Container): FastifyInstance {
  // A hop count becomes a function (the declared type has no number): the socket address is hop 0 and each trusted proxy
  // adds one, so req.ip is the address the outermost trusted proxy saw. Plain `true` is refused by the config schema.
  const setting = c.copilot?.ingest.trustProxy ?? false;
  const trustProxy = typeof setting === "number" ? (_address: string, hop: number) => hop < setting : setting;
  const app = Fastify({
    logger: false,
    bodyLimit: BODY_LIMIT_BYTES,
    requestIdHeader: false,
    // A webhook path token may have up to 128 characters (the config schemas) and the route accepts 256; Fastify's own
    // limit is 100, which would answer 414 before the connector ran and make a valid token unusable.
    maxParamLength: 256,
    // Fastify's own 414 body echoes the whole URL, which can hold a webhook token: answer in our format, without it.
    frameworkErrors: (err, req, res) => {
      const reply = res as unknown as FastifyReply;
      if (err.code === "FST_ERR_MAX_PARAM_LENGTH") {
        return void reply.code(414).send({ error: { code: "uri_too_long", message: "a path parameter is too long", requestId: req.id } });
      }
      return void reply.send(err); // every other framework error keeps Fastify's default answer
    },
    genReqId: (req) => requestIdFrom(req.headers["x-request-id"]),
    // Behind a reverse proxy (copilot.yaml ingest.trustProxy) req.ip is the client's, for the webhook IP allowlists.
    trustProxy: trustProxy,
  });

  // Review 2026-11: DNS rebinding (foreign Host) gets 421; a write with a cross-site Origin gets 403.
  const hostGuard = createHostGuard(c.config);
  const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
  app.addHook("onRequest", async (req, reply) => {
    if (!hostGuard.hostAllowed(req.headers.host)) {
      return reply.code(421).send({ error: { code: "host_not_allowed", message: "Host header not allowed; use a loopback address or ALLOWED_HOSTS", requestId: req.id } });
    }
    // API token (when set; required off loopback): every route but the /health probe and the webhooks needs it.
    // POST /ingest/* authenticates with each connector's own scheme instead (spec 008, decision 10).
    const path = req.url.split("?")[0] ?? "";
    const webhook = req.method === "POST" && path.startsWith("/ingest/");
    if (c.config.apiToken !== null && path !== "/health" && !webhook) {
      const auth = req.headers.authorization;
      const given = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
      if (!constantTimeEqualsText(given, c.config.apiToken)) {
        return reply.code(401).header("www-authenticate", "Bearer").send({ error: { code: "invalid_api_token", message: "invalid or missing API token (Authorization: Bearer)", requestId: req.id } });
      }
    }
    const origin = req.headers.origin;
    if (!SAFE_METHODS.has(req.method) && typeof origin === "string" && !hostGuard.originAllowed(origin)) {
      return reply.code(403).send({ error: { code: "cross_origin_write", message: "cross-site request refused", requestId: req.id } });
    }
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-request-id", req.id);
    return typeof payload === "string" ? redactSecrets(payload, c.secrets) : payload;
  });

  app.addHook("onResponse", async (req, reply) => {
    c.logger.info("request served", {
      requestId: req.id, method: req.method, url: redactThenClip(req.url, 200, c.secrets), statusCode: reply.statusCode, latencyMs: Math.round(reply.elapsedTime),
    });
  });

  app.setErrorHandler((err, req, reply) => {
    const { status, body, unexpected } = toHttpError(err, req.id);
    if (unexpected) {
      const e = err as { name?: unknown; message?: unknown };
      c.logger.error("unexpected error in request", {
        requestId: req.id, method: req.method, url: redactThenClip(req.url, 200, c.secrets), error: typeof e?.name === "string" ? e.name : "Error",
        detail: typeof e?.message === "string" ? redactThenClip(e.message, 500, c.secrets) : null,
      });
    }
    return reply.code(status).type("application/json; charset=utf-8").send(body);
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: { code: "route_not_found", message: `route not found: ${req.method} ${redactThenClip(req.url.split("?")[0] ?? "", 100, c.secrets)}`, requestId: req.id } }),
  );

  registerHealthRoutes(app, c);
  registerScenarioRoutes(app, c);
  registerIncidentRoutes(app, c, { maxConcurrentRuns: c.config.maxConcurrentRuns });
  registerApprovalRoutes(app, c);
  registerStatsRoutes(app, c);
  registerConnectorRoutes(app, c);
  registerIngestRoutes(app, c);
  return app;
}
