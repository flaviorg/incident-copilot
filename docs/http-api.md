# HTTP API

`npm start` brings up the Fastify API at `127.0.0.1:3000`. Error body: `{ "error": { "code", "message", "requestId", "issues"? } }`, with no stack trace. Every response carries `X-Request-Id`. Summary in the [README](../README.md#http-api).

## Routes

| Route | What it does | Errors |
|---|---|---|
| `GET /health` | provider and version | none |
| `GET /scenarios` | available scenarios | none |
| `POST /incidents` | opens an incident and runs the team until `awaiting_approval`, `resolved` or `escalated` (201) | 400; 404 `scenario_not_found`; 503 `llm_unavailable`; 504 `run_timeout` |
| `GET /incidents` | list with SQL filtering (`status`, `service`, `limit`) | 400 |
| `GET /incidents/:id` | full view: diagnosis, plan, actions, approvals, metrics | 404 |
| `GET /incidents/:id/trace` | events in `seq` order (`type`, `agent`, `limit`) | 404 |
| `GET /incidents/:id/audit` | audit trail with `prevHash` and `hash`, verifiable by the client (`incidentId` comes from the URL) | 404 |
| `GET /incidents/:id/postmortem` | Markdown or JSON (`format=md\|json`) | 404; 409 `postmortem_not_ready` |
| `GET /approvals` | approvals with their effective status (an expired one shows as `expired`, without writing) | 400 |
| `POST /approvals/:id/decision` | decides with `X-Approval-Token`; resumes when nothing is left pending | 400; 401; 404; 409; 422; 429; 503 |
| `GET /stats` | counts, MTTR P50 and P95, tiers, guards and LLM usage, all in SQL (`since=1h\|24h\|7d`) | 400 |

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
