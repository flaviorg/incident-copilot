// New Relic (spec 008): a workflow webhook destination in (Bearer, Basic or a custom header; New Relic documents no
// request signing) and NerdGraph NRQL out, from operator templates. Setup guide: docs/connectors/newrelic.md.
import { defineConnector } from "../types.ts";
import { verifyWebhookAuth } from "../shared/auth.ts";
import { newRelicConfigSchema } from "./config.ts";
import { parseNewRelicPayload } from "./ingest.ts";
import { createNewRelicQuery } from "./query.ts";

export const newRelicConnector = defineConnector({
  type: "newrelic",
  displayName: "New Relic",
  capabilities: ["ingest", "query"],
  configSchema: newRelicConfigSchema,
  create(config, deps) {
    const auth = config.ingest?.auth;
    return {
      id: deps.id,
      type: "newrelic",
      ingest: auth
        ? {
          verify: (req) => verifyWebhookAuth(auth, req),
          parse: (body, req) => parseNewRelicPayload(body, req, config),
        }
        : null,
      query: config.query ? createNewRelicQuery(config.query, deps.http) : null,
    };
  },
});
