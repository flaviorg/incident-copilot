# HTTP API

`npm start` brings up the Fastify API at `127.0.0.1:3000`. Error body: `{ "error": { "code", "message", "requestId", "issues"? } }`, with no stack trace. Every response carries `X-Request-Id`. Summary in the [README](../README.md#http-api).

Every route also answers:

- **401 `invalid_api_token`** when `API_TOKEN` is set and the request has no `Authorization: Bearer <API_TOKEN>` header (every route except `GET /health`, which stays open for probes, and the webhooks `POST /ingest/*`, which authenticate with each connector's own scheme). `API_TOKEN` is optional on loopback and required when `HOST` is not a loopback address: `npm start` refuses to start without it. The approval route still needs `X-Approval-Token` on top.
- **421 `host_not_allowed`** when the `Host` header is not a loopback name (`localhost`, `127.0.0.1`, `[::1]`), `HOST`, or one of `ALLOWED_HOSTS`. This stops DNS rebinding: a page that rebinds its own domain to `127.0.0.1` still sends its domain in `Host`.
- **403 `cross_origin_write`** on a write (`POST`) whose `Origin` header is not one of those hosts. CLI and `curl` send no `Origin` and are unaffected.

## Routes

| Route | What it does | Errors |
|---|---|---|
| `GET /health` | provider and version | none |
| `GET /scenarios` | available scenarios | none |
| `POST /incidents` | opens an incident and runs the team until `awaiting_approval`, `resolved` or `escalated` (201) | 400; 404 `scenario_not_found`; 429 `too_many_runs` (more than `MAX_CONCURRENT_RUNS`, default 2); 503 `llm_unavailable`; 504 `run_timeout` |
| `POST /incidents/:id/resume` | retries a resume whose run failed after every approval was decided (phase still `resume`); no token, since it only runs what humans already approved | 404; 409 `incident_not_accepting`; 429 `too_many_runs` |
| `GET /incidents` | list with SQL filtering (`status`, `service`, `limit`) | 400 |
| `GET /incidents/:id` | full view: diagnosis, plan, actions, approvals, metrics | 404 |
| `GET /incidents/:id/trace` | events in `seq` order (`type`, `agent`, `limit`) | 404 |
| `GET /incidents/:id/audit` | audit trail with `prevHash` and `hash`, verifiable by the client (`incidentId` comes from the URL) | 404 |
| `GET /incidents/:id/postmortem` | Markdown or JSON (`format=md\|json`); the Markdown ends with a "Code fix" section only when the incident has a code-fix attempt (spec 009), and the JSON never changes | 404; 409 `postmortem_not_ready` |
| `GET /incidents/:id/code-fix` | the incident's latest code-fix attempt (spec 009) as a `CodeFixAttemptView`: status, stage, reason, files, the `patch` and its `patchSha256`, test evidence, review and pull request. The post-images (`contents`) are never returned and every string is redacted | 404 `incident_not_found`; 404 `code_fix_not_found` |
| `GET /approvals` | approvals with their effective status (an expired action approval shows as `expired`, without writing). Code-fix approvals are listed after the action approvals and carry `subject: "code_fix"`, `patchSha256` and the attempt id in `actionId`; an overdue one is materialized as `expired` on read | 400 |
| `POST /approvals/:id/decision` | decides with `X-Approval-Token`; resumes when nothing is left pending. A code-fix decision leaves the incident unchanged and, on approval, queues the draft pull request | 400; 401; 404; 409 (including `code_fix_not_awaiting_approval`); 422; 429; 503 |
| `GET /stats` | counts, MTTR P50 and P95, tiers, guards and LLM usage, all in SQL (`since=1h\|24h\|7d`) | 400 |
| `POST /ingest/:connectorId` and `POST /ingest/:connectorId/:token` | live mode (spec 008): a provider webhook. Verified with the connector's scheme on the raw bytes, parsed, recorded and queued; answers **202** `{ accepted, duplicates, ignored, alertIds, requestId }` without running the graph. Any content type is read as raw bytes. Not behind `API_TOKEN` | 400 `invalid_payload` (body never echoed); 401 `invalid_webhook_credentials`; 404 `connector_not_found`; 413 `payload_too_large` (over `ingest.maxBodyBytes`, default 1 MiB); 415 for a malformed `Content-Type` header; 429 `ingest_rate_limited` with `Retry-After`; 503 `ingest_queue_full` with `Retry-After` |
| `GET /connectors` | configured, enabled connectors: `{ connectors: [{ id, type, capabilities, ingestPath }] }` | none |
| `GET /ingest/alerts` | recently ingested alerts, newest first: `{ alerts: IngestedAlertRecord[] }` (`limit` 1 to 200, default 50) | 400 |

A rejected webhook records nothing. `accepted` counts new alerts, `duplicates` counts alerts already recorded for the same
`(connectorId, externalId)`, and `alertIds` lists the new ones. Each alert then becomes, on the queue, `opened` (a new live
incident, run in shadow mode until `advised`), `deduplicated` (an open live incident of the same fingerprint),
`resolved`, `ignored` or `failed`; `GET /ingest/alerts` shows the outcome. Setup per provider: [docs/connectors/](connectors/).

The other routes keep a 64 KB body cap.

## Real `curl` sequence

Real sequence against `npm start`, with a fresh database and a local token of 16 or more characters exported in the shell as `APPROVAL_TOKEN` (the value does not appear in any output):

```text
$ npm start   # in another terminal
{"ts":"2026-10-08T09:01:45.095Z","level":"info","msg":"api listening","host":"127.0.0.1","port":3000,"provider":"fake"}

$ curl -s localhost:3000/health | jq -c .
{"status":"ok","provider":"fake","version":"0.1.0"}

$ curl -s -X POST localhost:3000/incidents -H 'content-type: application/json' -d '{"scenarioId":"deploy-5xx-rollback"}' | jq -c '{id: .incident.id, status: .incident.status, pending: [.approvals[] | select(.status=="pending") | .id]}'
{"id":"INC-0001","status":"awaiting_approval","pending":["APR-0001"]}

$ curl -s -X POST localhost:3000/approvals/APR-0001/decision -H 'content-type: application/json' -H 'X-Approval-Token: wrong-wrong-wrong' -d '{"decision":"approve","approver":"ana"}' | jq -c .error
{"code":"invalid_token","message":"invalid or missing approval token","requestId":"f7495050-dc02-429f-b9b5-05b7e82b2bf2"}

$ curl -s -X POST localhost:3000/approvals/APR-0001/decision -H 'content-type: application/json' -H "X-Approval-Token: $APPROVAL_TOKEN" -d '{"text":"yes, but wait","approver":"ana"}' | jq -c .error.code
"ambiguous_decision"

$ curl -s -X POST localhost:3000/approvals/APR-0001/decision -H 'content-type: application/json' -H "X-Approval-Token: $APPROVAL_TOKEN" -d '{"decision":"approve","approver":"ana"}' | jq -c '.incident.incident.status'
"resolved"

$ curl -s 'localhost:3000/stats?since=24h' | jq -c '{incidents: .incidents.byStatus, mttr: .mttrMin, tiers: .actions.byTier}'
{"incidents":{"open":0,"investigating":0,"awaiting_approval":0,"mitigating":0,"resolved":1,"escalated":0},"mttr":{"p50":2.1452,"p95":2.1452},"tiers":{"1":0,"2":2,"3":1,"4":0}}

$ curl -s localhost:3000/incidents/INC-0001/postmortem | head -6
# Post-mortem INC-0001: 5xx rate above 5% in orders-api

- Status: final
- Service: orders-api
- Narrative: deterministic template
- Blameless format: describes the system and the decisions, not people.

$ curl -s 'localhost:3000/incidents/INC-0001/postmortem?format=json' | jq -c .numericGuard
{"passed":false,"rejectedNumbers":["11.2"],"usedTemplate":true}
```

With the system clock, the scenario is shifted so that the alert matches the moment the incident is opened, and the API's MTTR depends on how long the operator takes to approve: about 2 min in this example.

The post-mortem came out through the template because the [numeric guard](../README.md#numbers-without-invention) rejected the "11.2" in the scripted narrative: that is the MTTR of the simulated timeline, and with the system clock the real MTTR was different.
