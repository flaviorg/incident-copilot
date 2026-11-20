// Prometheus Alertmanager (reference connector, spec 008): webhook_config in, payload version 4; Bearer or Basic auth.
// No query capability: Prometheus queries are a non-goal in 0.4 (the LLM never writes PromQL).
import { defineConnector } from "../types.ts";
import { verifyWebhookAuth } from "../shared/auth.ts";
import { alertmanagerConfigSchema } from "./config.ts";
import { parseAlertmanagerPayload } from "./ingest.ts";

export const alertmanagerConnector = defineConnector({
  type: "alertmanager",
  displayName: "Prometheus Alertmanager",
  capabilities: ["ingest"],
  configSchema: alertmanagerConfigSchema,
  create(config, deps) {
    const auth = config.ingest?.auth;
    return {
      id: deps.id,
      type: "alertmanager",
      ingest: auth
        ? {
          verify: (req) => verifyWebhookAuth(auth, req),
          parse: (body, req) => parseAlertmanagerPayload(body, req, config),
        }
        : null,
      query: null,
    };
  },
});
