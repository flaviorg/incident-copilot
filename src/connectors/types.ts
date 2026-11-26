// Connector port (spec 008, decision 1; docs/connectors-architecture.md). A connector is a definition registered in
// src/connectors/index.ts and configured in copilot.yaml. It may implement two capabilities:
// - ingest: verify an inbound webhook on the raw bytes and parse it into zero or more NormalizedAlerts;
// - query: read-only telemetry for the investigation, in the normalized records of src/contracts/live-telemetry.ts.
// The graph never imports a connector: it sees the same tool names for every provider.
import type * as z from "zod";
import type {
  DeployRecord, ErrorEvent, ErrorGroup, ExternalResult, ExternalToolInfo, LogEntry, MetricSeries, NormalizedAlert, ReleaseCommit,
  Severity,
} from "../contracts/index.ts";
import type { Logger } from "../infra/logger.ts";
import type { ConfigHelpers } from "./shared/config-helpers.ts";
import type { HttpClient } from "./shared/http.ts";

/**
 * Fields of the base copilot.yaml entry the registry adds to the config object it passes to `create`, beside the
 * output of `configSchema`. A definition's `configSchema` never declares them: the base entry owns `severityMap`
 * (`null` when the entry has none; the connector then uses its own default map).
 */
export type BaseEntryFields = { readonly severityMap: Readonly<Record<string, Severity>> | null };

export interface ConnectorDefinition<C> {
  /** "sentry"; also the name of the setup guide docs/connectors/<type>.md. Unique across connectors and notifiers. */
  readonly type: string;
  readonly displayName: string;
  readonly capabilities: readonly ("ingest" | "query")[];
  /** The connector entry without id, type, enabled and severityMap. Use z.strictObject and the helpers for text, secrets and URLs. */
  configSchema(h: ConfigHelpers): z.ZodType<C>;
  /** `config` is the parsed entry plus BaseEntryFields. */
  create(config: C & BaseEntryFields, deps: ConnectorDeps): ConnectorInstance;
}

export type ConnectorDeps = {
  /** Connector instance id from copilot.yaml (also the /ingest/:connectorId path segment). */
  id: string;
  /** HTTP client over the injected fetch: timeout, response cap, no redirects, errors as ConnectorError. */
  http: HttpClient;
  /** The raw injected fetch, for clients that need it (the MCP SDK transport). */
  fetch: typeof fetch;
  now: () => Date;
  /** Redacting logger bound to the connector id. Never log headers or bodies. */
  logger: Logger;
};

export interface ConnectorInstance {
  readonly id: string;
  readonly type: string;
  readonly ingest: IngestCapability | null;
  readonly query: QueryCapability | null;
  close?(): Promise<void>;
}

export type InboundRequest = {
  connectorId: string;
  requestId: string;
  receivedAt: Date;
  /** Lower-case names, first value. */
  headers: Readonly<Record<string, string>>;
  /** Exact bytes, for HMAC. */
  rawBody: Buffer;
  /** /ingest/:id/:token */
  pathToken: string | null;
  remoteAddress: string;
};

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; reason: "missing_credentials" | "invalid_credentials" | "invalid_signature" | "ip_not_allowed" };

export type ParseOutcome =
  | { kind: "alerts"; alerts: NormalizedAlert[] } // one payload may carry many (Alertmanager groups)
  | { kind: "ignored"; reason: string } // a valid event that is not an alert (Sentry installation, Bugsnag comment)
  | { kind: "invalid"; issues: string[] }; // fixed texts, never values from the payload

export interface IngestCapability {
  /** Sync, constant time, never throws. Runs on the raw bytes before JSON.parse. */
  verify(req: InboundRequest): VerifyOutcome;
  /** Sync, pure, never throws. Every text field must go through sanitizeText (asString does). */
  parse(body: unknown, req: InboundRequest): ParseOutcome;
}

export type QueryWindow = { from: Date; to: Date };
export type QueryIO = { signal: AbortSignal; now: Date };

/**
 * Read-only telemetry. Every member is optional: the registry lists a tool only when some source has it. A method
 * throws only ConnectorError (src/connectors/shared/errors.ts); `service` is already this connector's alias.
 */
export interface QueryCapability {
  /** Names query_metrics accepts for this source (the union over sources is offered to the model). */
  readonly metricNames?: readonly string[];
  metrics?(q: { service: string; metric: string; window: QueryWindow }, io: QueryIO): Promise<MetricSeries | null>;
  logs?(q: { service: string; level: "ERROR" | "WARN"; window: QueryWindow; limit: number }, io: QueryIO): Promise<LogEntry[]>;
  deploys?(q: { service: string; since: Date }, io: QueryIO): Promise<DeployRecord[]>;
  errors?(q: { service: string; window: QueryWindow; limit: number }, io: QueryIO): Promise<ErrorGroup[]>;
  /**
   * The exception and stack frames of the latest event of one error group (spec 009, decision 5), for the code fixer
   * only: not an LLM tool (no ReadToolName). `errorId` must match ^\d{1,20}$ or the method throws unsafe_input before
   * any request. Null when the group is unknown, belongs to another service or has no readable exception.
   */
  errorEvent?(q: { service: string; errorId: string }, io: QueryIO): Promise<ErrorEvent | null>;
  /** The release's last commit (40-hex SHA and repository name); null when the release has none. Not an LLM tool. */
  releaseCommit?(q: { service: string; version: string }, io: QueryIO): Promise<ReleaseCommit | null>;
  external?: {
    tools(io: QueryIO): Promise<ExternalToolInfo[]>;
    call(tool: string, args: Record<string, unknown>, io: QueryIO): Promise<ExternalResult>;
  };
}

/** Erases the config type so definitions of every connector fit one list (CONNECTOR_DEFINITIONS). */
export function defineConnector<C>(d: ConnectorDefinition<C>): ConnectorDefinition<unknown> {
  return d as unknown as ConnectorDefinition<unknown>;
}
