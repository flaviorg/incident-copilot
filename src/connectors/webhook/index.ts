// Generic JSON webhook (spec 008): any tool that can POST JSON can open incidents. The copilot.yaml entry maps body
// fields to the normalized alert; auth is Bearer, Basic, a custom header, HMAC over the raw body or a secret URL token.
// No query capability.
import { defineConnector } from "../types.ts";
import { webhookConfigSchema } from "./config.ts";
import { createWebhookIngest } from "./ingest.ts";

export const webhookConnector = defineConnector({
  type: "webhook",
  displayName: "Generic JSON webhook",
  capabilities: ["ingest"],
  configSchema: webhookConfigSchema,
  create(config, deps) {
    return { id: deps.id, type: "webhook", ingest: createWebhookIngest(config), query: null };
  },
});
