# 008: Connectors and live incidents

Milestone M8, release 0.4.0. Status: implemented.

## Context

Up to 0.3.0 every incident comes from a recorded scenario. This milestone makes the copilot plug into a company's own observability and error stack: providers send alerts by webhook, the copilot opens (or deduplicates into) an incident, investigates with real, read-only data from the same providers, and posts its diagnosis and recommended plan to the team's chat.

The thesis does not change: **the model proposes; code and humans decide.** In 0.4 every live incident runs in **shadow mode**: diagnosis, runbooks, plan, auditor and the gate's tier classification run, but nothing executes. Real executors are on the roadmap.

The design lives in `docs/connectors-architecture.md`. This file holds the scope, the decisions, the contracts and the acceptance criteria.

## Scope

- **Connector port** (`src/connectors/types.ts`) with two capabilities a connector may implement:
  - `ingest`: verify an inbound webhook and parse it into zero or more `NormalizedAlert`s;
  - `query`: read-only telemetry for the investigation (error groups, metrics, logs, deploys or releases, and external MCP tools).
- **Notifier port** (`src/notifiers/types.ts`) for outbound messages.
- Connectors and notifiers are **configured, not hard-coded**: a registry of definitions (`src/connectors/index.ts`, `src/notifiers/index.ts`) and a `copilot.yaml` file.
- v0.4 connectors:

  | Type | Ingest | Query |
  |---|---|---|
  | `alertmanager` (reference, in core) | Alertmanager `webhook_config`, payload version 4; Bearer or Basic | no |
  | `newrelic` | Workflows webhook destination with the documented template; Bearer, Basic or a custom header | NerdGraph NRQL from configured templates |
  | `sentry` | Integration Platform webhooks (`event_alert`, `metric_alert`, `issue`) with HMAC-SHA256 signature | REST: project issues and releases (the latest event of an issue is not read in 0.4) |
  | `bugsnag` | Data Forwarding webhook; secret URL token and optional IP allowlist | Data Access API v2: errors, releases |
  | `webhook` | Any JSON, with field mapping in the config; Bearer, Basic, header, HMAC or URL token | no |
  | `mcp` | no | Allowlisted read-only tools of any MCP server (for example New Relic's or Sentry's) |

- v0.4 notifiers: `slack` (incoming webhook) and `outbound-webhook` (generic outbound JSON, optionally HMAC-signed). Notifier types share the `docs/connectors/` folder with connector types, so their names never collide.
- **Live mode**: `POST /ingest/:connectorId` (and `/ingest/:connectorId/:token`) answers 202 fast; an in-process queue runs the incident under the shared `MAX_CONCURRENT_RUNS` cap.
- **Config** `copilot.yaml` (path in `COPILOT_CONFIG`), zod-validated, `${VAR}` interpolation, secrets only as `${VAR}`. CLI `config check`.
- **Read API**: `GET /connectors` and `GET /ingest/alerts`.
- **Packaging**: `Dockerfile`, `docker-compose.yml`, `copilot.example.yaml`, one setup guide per provider in `docs/connectors/<type>.md`, README "Connect your stack", CHANGELOG 0.4.0.

## Decisions

1. **One port, capabilities as optional members.** A connector is a definition `{ type, capabilities, configSchema(helpers), create(config, deps) }`. A provider that only receives alerts (Alertmanager) implements `ingest`; a pure data source (MCP) implements `query`. A provider-specific feature never leaks into the graph: the graph sees the same tool names for every provider.
2. **Provider-agnostic tools.** The telemetry analyst keeps its vocabulary. Live incidents get `query_metrics`, `query_logs`, `list_deploys` and two new tier-1 tools, `query_errors` and `query_external`, each listed only when some configured connector has the matching query capability. Connectors return normalized records (`src/contracts/live-telemetry.ts`); one pure formatter writes the observation, so summaries look the same whatever the vendor.
3. **Scenario mode stays byte-identical.** The registry chooses the tool set by the incident context. For a scenario it exposes the same 4 tools, same order and same descriptions, so the prompt text, the fake's token estimates and the goldens do not change. No `system` text changes in 0.4, so no fixture rehash is needed.
4. **Async tools.** `Tool.run` and `ToolRegistry.run` return `Promise<ToolResult>`; `names` and `describeForPrompt` are async and take the context. The registry still never throws.
5. **Incident context, not scenarios, in the nodes.** Telemetry, auditor, reporter, executor and verifier receive an `IncidentContextResolver` instead of the `ScenarioRepository`. For a scenario it returns the same `LoadedScenario` as today; for a live incident it returns the configured query sources. The executor and the verifier refuse a live context (unreachable in shadow mode).
6. **Shadow is the only live mode.** `mode: shadow` is a literal in the config schema. The blackboard gains an optional `origin` (absent in scenario mode). With `origin.mode === "shadow"` the gate classifies, validates parameters and checks dependencies; tier 2 and 3 steps become `recommended` (new action status), tier 4 and unknown types are blocked as today; no dry run, no approval, no execution; the gate routes to the reporter, which writes an `advisory` report from the template (no LLM call). The incident ends `advised` (new status), or `escalated` when the team escalates.
7. **Live incidents reuse the incident model.** `scenarioId` is the sentinel `live:<connectorId>` (no schema change, no nullable column). The fake provider finds a script by that id in tests; `npm start` refuses ingest connectors with the fake provider.
8. **Idempotency and dedupe are separate.** Idempotency: `(connectorId, externalId)` is unique in `ingested_alerts`; a repeat is a duplicate. Dedupe: a firing alert whose `(connectorId, fingerprint)` has an open live incident younger than `ingest.dedupeWindowMin` joins that incident without a new run. A resolved alert closes the live incident and marks it `resolved`. Cross-provider correlation is out of scope.
9. **Fast acknowledgement.** Verify, parse, record and enqueue happen in the request; the graph runs on the queue. Sentry treats a response slower than 1 second as a timeout.
10. **Webhook authentication is per connector and mandatory.** `/ingest/*` is exempt from `API_TOKEN` and authenticates with the connector's own scheme: HMAC where the provider signs (Sentry, and the generic webhook when configured), otherwise Bearer, Basic, a custom header or a secret URL token. No connector may be configured without ingest authentication. Every comparison is constant-time. Body cap (`ingest.maxBodyBytes`, default 1 MiB) and a per-connector token bucket (`ingest.rateLimitPerMin`, default 60).
11. **All inbound and queried text is untrusted.** It is sanitized (control characters removed, delimiters neutralized, clipped) and reaches the LLM only as alert data or inside `<<<UNTRUSTED OBSERVATION>>>`. No tier, approval or execution decision reads it. NRQL and other query languages are built only from config templates; values substituted into them pass a strict character allowlist; the LLM never writes a query string in 0.4. This covers `query_external` too: the MCP connector sends the operator's `arguments` template and the model only fills the `{service}` and `{window}` placeholders, each against an allowlist (any other key is `unsafe_input`).
12. **YAML dependency.** `yaml@2.8.1` (exact): operators hand-edit this file and need comments, which JSON lacks; Node 24 has no YAML parser; the package has no dependencies and ships its own types. It parses with the core schema and the default alias cap, and the result is validated by zod. `.json` files are also accepted with `JSON.parse`. The API is recorded in `docs/api-notes.md` before use.
13. **No other new dependency.** HTTP uses `fetch` (injectable), HMAC uses `node:crypto`, the MCP client uses the existing `@modelcontextprotocol/sdk@1.32.0`.
14. **Notifications never decide.** A notifier failure is logged (redacted) and never changes incident state. Messages carry the diagnosis, the recommendations with their catalog tiers and links; Slack text is escaped (`&`, `<`, `>`).

## Contracts

`src/contracts/ingest.ts` (zod, browser-safe):

```ts
export const ConnectorIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export const AlertSignalSchema = z.enum([...MetricNameSchema.options, "error_events", "other"]);
export const NormalizedAlertSchema = z.object({
  source: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), // connector type, e.g. "sentry"
  externalId: z.string().min(1).max(200),               // idempotency key of the provider event
  fingerprint: z.string().min(1).max(200),              // grouping key for dedupe
  service: z.string().min(1).max(120).nullable(),       // raw name from the payload, mapped later
  title: z.string().min(1).max(200),
  severity: SeveritySchema,
  status: z.enum(["firing", "resolved"]),
  startedAt: z.iso.datetime(),                          // normalized to toISOString()
  url: z.string().max(2000).nullable(),                 // http(s) only, else null
  signal: AlertSignalSchema,
  attributes: z.record(z.string().max(64), z.string().max(500)), // at most 20 keys
});
export const IngestOutcomeSchema = z.enum(["queued", "opened", "deduplicated", "resolved", "ignored", "failed"]);
export const IngestedAlertRecordSchema = z.object({
  id: z.string(), connectorId: ConnectorIdSchema, alert: NormalizedAlertSchema, receivedAt: z.iso.datetime(),
  requestId: z.string().nullable(), outcome: IngestOutcomeSchema, incidentId: z.string().nullable(), detail: z.string().max(300).nullable(),
});
export const IncidentOriginSchema = z.object({
  kind: z.literal("connector"), connectorId: ConnectorIdSchema, source: z.string(), fingerprint: z.string(),
  alertId: z.string(), externalUrl: z.string().nullable(), mode: z.literal("shadow"),
});
```

Changes to existing contracts (all additive; absent values keep recordings and goldens identical):

| Contract | Change |
|---|---|
| `AlertSchema.signal` | `MetricNameSchema` becomes `AlertSignalSchema` |
| `BlackboardSchema` | `origin: IncidentOriginSchema.optional()` |
| `IncidentStatusSchema` | adds `advised` |
| `ActionStatusSchema` | adds `recommended` |
| `PostmortemDocSchema.status` | adds `advisory` |
| `AuditEventSchema` | adds `alert_ingested`, `alert_resolved`, `action_recommended` |
| `ReadToolNameSchema` | adds `query_errors`, `query_external` |
| `EvidenceSchema.source` | adds `errors`, `external` (output schema only, not hashed; `system` text unchanged) |

`src/contracts/live-telemetry.ts`: `MetricSeries`, `LogEntry`, `DeployRecord`, `ErrorGroup`, `ExternalToolInfo`, `ExternalResult` (fields in the architecture document).

Database (schema version 4): new tables `ingested_alerts` (unique `connector_id, external_id`) and `live_incidents` (partial unique index on `connector_id, fingerprint` where `closed_at IS NULL`); a migration rebuilds `incidents`, `actions` and `audit_log` when their stored CHECK lacks a new enum value, keeping rows, `seq`, the hash chain and the append-only triggers.

HTTP:

| Route | Auth | Success | Errors |
|---|---|---|---|
| `POST /ingest/:connectorId` and `/ingest/:connectorId/:token` | connector scheme, not `API_TOKEN` | 202 `{ accepted, duplicates, ignored, alertIds, requestId }` | 400 `invalid_payload`; 401 `invalid_webhook_credentials`; 404 `connector_not_found`; 413; 429 `ingest_rate_limited` with `Retry-After`; 503 `ingest_queue_full` |
| `GET /connectors` | `API_TOKEN` when set | 200 list of `{ id, type, capabilities, ingestPath }` | none |
| `GET /ingest/alerts?limit=` | `API_TOKEN` when set | 200 recent `IngestedAlertRecord`s | 400 |

## Non-goals

- Executing any action on real infrastructure, and any operating mode other than `shadow` for live incidents. Tier 4 stays forbidden by construction.
- Cross-provider correlation of alerts (one outage seen by New Relic and Sentry opens two incidents).
- Two-way sync (acknowledging or closing the provider's issue), Slack interactivity and approvals from chat.
- LLM-written queries (NRQL, PromQL, Sentry search) and a Prometheus query connector.
- OAuth flows for MCP servers: 0.4 sends static headers only.
- Persistent or distributed queue: the queue is in process; queued alerts are recovered from the database on start, a run interrupted by a crash is not resumed.
- A War Room live view of connector incidents and live incidents in demo recordings.
- Multi-tenant configuration and per-user roles.

## Acceptance criteria (EARS)

- **AC-42** When a webhook reaches `POST /ingest/:connectorId` with valid credentials and a parseable payload, the system shall record each normalized alert as `queued`, enqueue it and respond 202, without calling the LLM or running the graph inside the request.
- **AC-43** If ingest credentials are missing or wrong, the signature does not match the raw body, or the source IP is outside a configured allowlist, then the system shall respond 401 `invalid_webhook_credentials` with a generic message, compare in constant time, record nothing and log no credential value.
- **AC-44** If the body exceeds `ingest.maxBodyBytes`, the connector exceeds its rate, the connector is unknown or has no ingest capability, the payload is not valid for the connector, or the queue is full, then the system shall respond 413, 429 `ingest_rate_limited` with `Retry-After`, 404 `connector_not_found`, 400 `invalid_payload` without echoing the body, or 503 `ingest_queue_full`, and record nothing.
- **AC-45** When an alert with an already recorded `(connectorId, externalId)` arrives, the system shall count it as a duplicate in the 202 response and shall neither enqueue it nor open or change an incident.
- **AC-46** When a firing alert arrives whose `(connectorId, fingerprint)` has an open live incident younger than `ingest.dedupeWindowMin`, the system shall attach it to that incident with audit `alert_ingested` (`deduplicated: true`) and start no run.
- **AC-47** When a resolved alert arrives for a fingerprint with an open live incident, the system shall audit `alert_resolved`, close the live incident and mark the incident `resolved` with the provider's time, after any run of that fingerprint finishes; a resolved alert without an open incident shall be recorded as `ignored`.
- **AC-48** While live alerts are processed, the system shall run at most `MAX_CONCURRENT_RUNS` graph runs at a time, shared with `POST /incidents`, and process the jobs of one fingerprint in arrival order.
- **AC-49** While an incident's origin mode is `shadow`, the gate shall classify every step with `classifyAction`, record accepted tier 2 and tier 3 steps as `recommended` with audit `action_recommended`, block tier 4 and unknown types as in AC-11, run no dry run, create no approval, execute nothing and hand off to the reporter; the incident shall end `advised` with an `advisory` report, or `escalated`.
- **AC-50** The system shall treat inbound payload text, connector query results and MCP tool descriptions and results as untrusted: sanitized and clipped, given to the LLM only as alert data or inside an untrusted observation, and never used to choose a tier, an approval or an execution.
- **AC-51** When the copilot config is loaded (server start or `config check`), the system shall validate it with zod, interpolate `${VAR}` in non-secret strings, accept a secret only as a whole `${VAR}` reference to a set variable, accept `mode: shadow` only, and report each problem as `{ path, rule }` without echoing any value; `config check` shall exit 0 when valid and 1 otherwise.
- **AC-52** The system shall add every secret resolved from the copilot config to the redaction list, so it appears in no HTTP response, log, trace, audit entry, notification or CLI output.
- **AC-53** When a telemetry tool runs for a live incident, the registry shall call the configured query capabilities through an injected HTTP transport with a per-call timeout and turn authentication errors, rate limits, timeouts and malformed responses into `ok: false` observations, never throwing.
- **AC-54** The system shall keep scenario mode unchanged: the scenario tool descriptions, metrics goldens, audit sequences, demo recordings and fixture prompt hashes stay byte-identical.
- **AC-55** If the copilot config declares an ingest connector and the LLM provider is `fake`, then `npm start` shall refuse to start with a configuration error; and if a live run fails for any reason, then the queue shall record the alert as `failed` and keep processing other jobs.
- **AC-56** When a live incident is opened, its analysis is ready, its run fails or it is resolved, the system shall send a redacted message to every notifier subscribed to that event, with the recommendations and their catalog tiers; a notifier failure shall be logged and shall not change the incident.
- **AC-57** When a Sentry webhook arrives, the connector shall verify `Sentry-Hook-Signature` as the HMAC-SHA256 hex digest of the raw body keyed with the client secret before parsing it.
- **AC-58** When the `mcp` connector lists tools, it shall expose only allowlisted tools, refuse any tool the server annotates as destructive or not read-only, and return only text content, clipped, as an untrusted observation.
- **AC-59** The system shall ship, for every registered connector and notifier type, a passing conformance test and a setup guide at `docs/connectors/<type>.md`.

## How to verify

| Criterion | Tests |
|---|---|
| AC-42, AC-44, AC-45 | `tests/e2e/ingest.e2e.test.ts` |
| AC-43 | `tests/unit/connectors-auth.unit.test.ts`; `tests/e2e/ingest.e2e.test.ts` |
| AC-46, AC-47, AC-48 | `tests/unit/alert-queue.unit.test.ts`; `tests/e2e/live-incident.e2e.test.ts` |
| AC-49 | `tests/unit/nodes-gate.unit.test.ts` (shadow cases); `tests/unit/routing.unit.test.ts`; `tests/unit/derive-status.unit.test.ts`; `tests/e2e/live-incident.e2e.test.ts` |
| AC-50 | `tests/e2e/live-incident.e2e.test.ts` (injected instruction in the alert title and in an error message); `tests/unit/connectors-mcp.unit.test.ts` |
| AC-51, AC-52 | `tests/unit/copilot-config.unit.test.ts`; `tests/e2e/cli.e2e.test.ts` (`config check`) |
| AC-53 | `tests/unit/tools-live.unit.test.ts`; each `tests/unit/connectors-<type>.unit.test.ts` |
| AC-54 | `tests/unit/tools.unit.test.ts` (frozen description); `tests/e2e/scenarios.e2e.test.ts`; `tests/e2e/demo-recordings.e2e.test.ts`; `tests/unit/contracts.unit.test.ts` |
| AC-55 | `tests/unit/copilot-config.unit.test.ts` (`assertLiveSafe`); `tests/unit/alert-queue.unit.test.ts` |
| AC-56 | `tests/e2e/live-incident.e2e.test.ts`; `tests/unit/notifiers-slack.unit.test.ts`; `tests/unit/notifiers-outbound-webhook.unit.test.ts` |
| AC-57 | `tests/unit/connectors-sentry.unit.test.ts` |
| AC-58 | `tests/unit/connectors-mcp.unit.test.ts` |
| AC-59 | `tests/unit/connectors-registry.unit.test.ts` |

Demonstrable milestone: `docker compose up`, then the README `curl` that posts an Alertmanager payload and reads the `advised` incident.

## Reference

Provider facts and their sources are listed per connector in `docs/connectors/<type>.md`. Facts not confirmed in the provider's documentation are marked as unverified there and handled defensively in code.
