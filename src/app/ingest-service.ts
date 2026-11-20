// Inbound webhooks (spec 008, decisions 8 to 11; AC-42 to AC-45): verify, parse, map, record and enqueue inside the
// request; the graph runs later on the queue, so the provider gets 202 fast. Nothing is recorded on a rejection.
import { NormalizedAlertSchema } from "../contracts/index.ts";
import type { NormalizedAlert } from "../contracts/index.ts";
import type { SqliteIncidentStore } from "../infra/db/incident-store.ts";
import type { Clock } from "../infra/clock.ts";
import type { Ids } from "../infra/ids.ts";
import type { Logger } from "../infra/logger.ts";
import type { CopilotConfig } from "../infra/copilot-config/schema.ts";
import { sanitizeAttributes, sanitizeText } from "../domain/ingest/sanitize.ts";
import { canonicalService } from "../domain/ingest/service-map.ts";
import { createTokenBucket } from "../domain/ingest/token-bucket.ts";
import type { TokenBucket } from "../domain/ingest/token-bucket.ts";
import type { ConnectorRegistry } from "../connectors/registry.ts";
import type { InboundRequest } from "../connectors/types.ts";
import type { AlertQueue } from "./alert-queue.ts";

export type IngestRejectionCode = "invalid_payload" | "invalid_webhook_credentials" | "connector_not_found" | "ingest_rate_limited" | "ingest_queue_full";

export type IngestResult =
  | { kind: "accepted"; accepted: number; duplicates: number; ignored: string | null; alertIds: string[] }
  | { kind: "rejected"; status: 400 | 401 | 404 | 429 | 503; code: IngestRejectionCode; retryAfterSec?: number };

export type IngestService = {
  receive(connectorId: string, req: InboundRequest): IngestResult;
  /** On start: re-enqueues the rows still queued (a crash between record and run). */
  recoverQueued(): number;
};

const reject = (status: 400 | 401 | 404 | 429 | 503, code: IngestRejectionCode, retryAfterSec?: number): IngestResult =>
  ({ kind: "rejected", status, code, ...(retryAfterSec !== undefined ? { retryAfterSec } : {}) });

/** Text of an alert once more through the sanitizer (the connector's output is not trusted either), with the canonical service. */
function remap(a: NormalizedAlert, connectorId: string, services: CopilotConfig["services"]): unknown {
  const service = a.service === null ? null : canonicalService(services, connectorId, sanitizeText(a.service, 120));
  return {
    ...a,
    externalId: sanitizeText(a.externalId, 200),
    fingerprint: sanitizeText(a.fingerprint, 200),
    service: service === null || service === "" ? null : sanitizeText(service, 120),
    title: sanitizeText(a.title, 200) || "alert",
    url: a.url,
    attributes: sanitizeAttributes(a.attributes ?? {}),
  };
}

export function createIngestService(o: {
  store: SqliteIncidentStore;
  registry: ConnectorRegistry;
  queue: AlertQueue;
  copilot: CopilotConfig;
  clock: Pick<Clock, "now">;
  ids: Pick<Ids, "alert">;
  logger: Logger;
}): IngestService {
  const buckets = new Map<string, TokenBucket>();
  const bucketOf = (id: string) => {
    let b = buckets.get(id);
    if (!b) {
      b = createTokenBucket({ ratePerMin: o.copilot.ingest.rateLimitPerMin, now: () => o.clock.now().getTime() });
      buckets.set(id, b);
    }
    return b;
  };

  return {
    receive(connectorId, req) {
      const log = o.logger.child({ requestId: req.requestId, connectorId });
      const connector = o.registry.get(connectorId);
      if (!connector?.ingest) return reject(404, "connector_not_found");

      // Credentials first: a request that does not authenticate must never spend the connector's tokens, or anyone who
      // knows its id could keep the bucket empty and starve the real provider.
      const verified = connector.ingest.verify(req);
      if (!verified.ok) {
        log.warn("webhook credentials refused", { event: "ingest_unauthorized", reason: verified.reason });
        return reject(401, "invalid_webhook_credentials");
      }

      const permit = bucketOf(connectorId).take();
      if (!permit.ok) {
        log.warn("ingest rate limited", { event: "ingest_rate_limited", retryAfterSec: permit.retryAfterSec });
        return reject(429, "ingest_rate_limited", permit.retryAfterSec);
      }

      let body: unknown;
      try {
        body = JSON.parse(req.rawBody.toString("utf8"));
      } catch {
        log.warn("webhook body is not JSON", { event: "ingest_invalid", reason: "not_json" });
        return reject(400, "invalid_payload");
      }

      let parsed;
      try {
        parsed = connector.ingest.parse(body, req);
      } catch {
        parsed = { kind: "invalid" as const, issues: ["parser failed"] };
      }
      if (parsed.kind === "invalid") {
        log.warn("webhook payload refused by the connector", { event: "ingest_invalid", issues: parsed.issues.slice(0, 5).map((i) => sanitizeText(String(i), 200)) });
        return reject(400, "invalid_payload");
      }
      if (parsed.kind === "ignored") {
        log.info("webhook acknowledged and ignored", { event: "ingest_ignored", reason: sanitizeText(parsed.reason, 200) });
        return { kind: "accepted", accepted: 0, duplicates: 0, ignored: sanitizeText(parsed.reason, 200), alertIds: [] };
      }

      const alerts: NormalizedAlert[] = [];
      let dropped = 0;
      for (const a of parsed.alerts) {
        const r = NormalizedAlertSchema.safeParse(remap(a, connectorId, o.copilot.services));
        if (r.success) alerts.push(r.data);
        else dropped += 1;
      }
      if (dropped > 0) log.warn("invalid alerts dropped", { event: "ingest_alerts_dropped", dropped });
      if (alerts.length === 0) {
        return { kind: "accepted", accepted: 0, duplicates: 0, ignored: "no valid alert in the payload", alertIds: [] };
      }

      // Back-pressure: refuse (503, before writing anything, so a retry loses nothing) only when the queue is already
      // full. A request is never split or refused for being larger than the room left: the rows are the durable queue
      // (recoverQueued), and a group above maxQueued would otherwise get 503 on every retry, with an empty queue.
      const hasFresh = alerts.some((a) => !o.store.hasIngestedAlert(connectorId, a.externalId));
      if (hasFresh && o.queue.capacityLeft() === 0) {
        log.warn("ingest queue full", { event: "ingest_queue_full", queued: o.queue.size() });
        return reject(503, "ingest_queue_full", 30);
      }

      const receivedAt = req.receivedAt.toISOString();
      const recorded = o.store.transaction(() =>
        alerts.map((alert) => ({ alert, ...o.store.recordIngestedAlert({ connectorId, alert, receivedAt, requestId: req.requestId }, () => o.ids.alert()) })),
      );
      const inserted = recorded.filter((r) => r.inserted);
      for (const r of inserted) o.queue.enqueue({ alertId: r.id, connectorId, fingerprint: r.alert.fingerprint });
      log.info("webhook accepted", { event: "ingest_accepted", accepted: inserted.length, duplicates: recorded.length - inserted.length });
      return { kind: "accepted", accepted: inserted.length, duplicates: recorded.length - inserted.length, ignored: null, alertIds: inserted.map((r) => r.id) };
    },

    recoverQueued() {
      const rows = o.store.listQueuedAlerts();
      for (const r of rows) o.queue.enqueue({ alertId: r.id, connectorId: r.connectorId, fingerprint: r.alert.fingerprint });
      if (rows.length > 0) o.logger.info("queued alerts recovered", { event: "ingest_recovered", count: rows.length });
      return rows.length;
    },
  };
}
