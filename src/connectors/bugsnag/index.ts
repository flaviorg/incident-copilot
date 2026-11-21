// Bugsnag (SmartBear Insight Hub), spec 008. Ingest: Data Forwarding webhook, authenticated by a secret URL token and an
// optional IP allowlist (Bugsnag documents no signature). Query: Data Access API v2 (errors and releases of a project).
import { defineConnector } from "../types.ts";
import { verifyWebhookAuth } from "../shared/auth.ts";
import type { WebhookAuthConfig } from "../shared/auth.ts";
import { bugsnagConfigSchema } from "./config.ts";
import { parseBugsnagPayload } from "./ingest.ts";
import { createBugsnagQuery } from "./query.ts";

export const bugsnagConnector = defineConnector({
  type: "bugsnag",
  displayName: "Bugsnag",
  capabilities: ["ingest", "query"],
  configSchema: bugsnagConfigSchema,
  create(config, deps) {
    const ingest = config.ingest;
    const auth: WebhookAuthConfig | null = ingest
      ? { type: "path_token", token: ingest.token, ...(ingest.allowedIps ? { allowedIps: ingest.allowedIps } : {}) }
      : null;
    return {
      id: deps.id,
      type: "bugsnag",
      ingest: ingest && auth
        ? {
          verify: (req) => verifyWebhookAuth(auth, req),
          parse: (body, req) => parseBugsnagPayload(body, req, { triggers: ingest.triggers, severityMap: config.severityMap }),
        }
        : null,
      query: config.query ? createBugsnagQuery(config.query, deps.http) : null,
    };
  },
});
