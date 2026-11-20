// Sentry (spec 008, AC-57): signed integration-platform webhooks in, REST queries out (issues as error groups, releases
// as deploys). No metrics or logs capability. Service aliases in copilot.yaml are Sentry project slugs.
import { defineConnector } from "../types.ts";
import { sentryConfigSchema } from "./config.ts";
import { parseSentryPayload, verifySentrySignature } from "./ingest.ts";
import { createSentryQuery } from "./query.ts";

export const sentryConnector = defineConnector({
  type: "sentry",
  displayName: "Sentry",
  capabilities: ["ingest", "query"],
  configSchema: sentryConfigSchema,
  create(config, deps) {
    const ingest = config.ingest;
    const query = config.query;
    return {
      id: deps.id,
      type: "sentry",
      ingest: ingest
        ? {
          verify: (req) => verifySentrySignature(ingest, req),
          parse: (body, req) => parseSentryPayload(body, req, { ...ingest, severityMap: config.severityMap }),
        }
        : null,
      query: query ? createSentryQuery(query, deps.http) : null,
    };
  },
});
