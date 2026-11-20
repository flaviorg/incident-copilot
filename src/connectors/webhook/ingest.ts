// Ingest capability of the generic webhook connector: the shared auth schemes verify the raw bytes (HMAC included),
// then the mapping turns the parsed body into alerts.
import { verifyWebhookAuth } from "../shared/auth.ts";
import type { IngestCapability } from "../types.ts";
import type { BaseEntryFields } from "../types.ts";
import type { WebhookConfig } from "./config.ts";
import { applyMapping } from "./mapping.ts";

export function createWebhookIngest(config: WebhookConfig & BaseEntryFields): IngestCapability {
  const { auth, mapping, maxAlertsPerRequest } = config.ingest;
  return {
    verify: (req) => verifyWebhookAuth(auth, req),
    parse: (body, req) => applyMapping(mapping, body, req, { maxAlertsPerRequest, severityMap: config.severityMap }),
  };
}
