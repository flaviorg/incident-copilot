# 005: HTTP API

Milestone M5. Status: implemented.

## Context

The API is the port for anyone who wants to integrate the copilot: open incidents, read diagnosis, trace, audit and post-mortem, and decide approvals with a token. It is also the only port through which a human approves. Error codes are stable and carry no stack. Every response carries `X-Request-Id`, which reaches the trace, logs and audit.

## Scope

- `buildServer(container)` on Fastify 5, without `listen`, testable via `app.inject`. `src/index.ts` starts the API on `127.0.0.1:3000`, with graceful shutdown.
- Routes:
  - `GET /health` and `GET /scenarios`;
  - `POST /incidents`, `GET /incidents`, `GET /incidents/:id`;
  - `GET /incidents/:id/trace`, `/audit` and `/postmortem`;
  - `GET /approvals` and `POST /approvals/:id/decision`;
  - `GET /stats`.
- Error body `{ error: { code, message, requestId, issues? } }`. Typed errors mapped to status codes. Body up to 64 KB. Secret redaction in `onSend`.
- `X-Request-Id` reused when it matches `^[A-Za-z0-9._-]{1,64}$`; otherwise generated.
- `/stats` with SQL aggregations: counts, nearest-rank MTTR P50 and P95, tiers, approvals with projected expiration, guard counters and LLM usage.
- Run timeout via `RUN_TIMEOUT_MS` (504).

## Non-goals

- CORS: no browser talks to the API in v1. The War Room live mode is in the v2 backlog.
- HTTP rate limiting (`@fastify/rate-limit`): the API listens only on `127.0.0.1`. There is an execution limit and a lockout after token attempts.
- Read authentication: only the decision requires a token.
- Trace streaming (SSE).
- Docker image and backend deploy.

## Acceptance criteria (EARS)

- **AC-01** When `POST /incidents` receives an existing `scenarioId`, the system shall create the incident, run the team until `awaiting_approval`, `resolved` or `escalated`, persist the status derived from table 4.5.2 and respond 201 with the `IncidentView`.
- **AC-16** If the approval token is missing or wrong, then the system shall respond 401 with a generic message, record `approval_auth_failed` without the received value, and not change state.
- **AC-18** If there are 5 wrong token attempts within 10 minutes, then the system shall refuse decisions for 10 minutes with 429.
- **AC-30** If the run exceeds `RUN_TIMEOUT_MS`, then the API shall respond 504 and the incident shall end `escalated` with `timeout` and a partial post-mortem.
- **AC-32** When the body or query fails Zod validation, the API shall respond 400 with `code: "validation_error"` and `issues`, without a stack trace; and every response shall carry `X-Request-Id`, reusing the received one when valid.
- **AC-33** When `GET /stats` is called, the system shall return counts and MTTR P50 and P95 computed in SQL over the requested window.

Endpoints and errors (design section 5.3):

| Route | Success | Errors |
|---|---|---|
| `POST /incidents` | 201 `IncidentView` | 400; 404 `scenario_not_found`; 503 `llm_unavailable`; 504 `run_timeout` |
| `GET /incidents/:id/postmortem` | 200 Markdown or JSON | 404; 409 `postmortem_not_ready` |
| `POST /approvals/:id/decision` | 200 `{ approval, incident }`, including when the resume escalates | 400; 401 `invalid_token`; 404; 409 `approval_not_pending`, `approval_expired` or `incident_not_accepting` (incident run still in progress); 422 `ambiguous_decision`; 429 `approvals_locked`; 503 `approvals_disabled` |

## How to verify

| Criterion | Tests |
|---|---|
| AC-01 | `tests/e2e/http.e2e.test.ts` ("POST /incidents creates and stops awaiting approval") |
| AC-16 | `tests/e2e/http.e2e.test.ts` ("decision codes: 401, 422, 400, 200, 409"); `tests/e2e/gate.e2e.test.ts` ("token rules") |
| AC-18 | `tests/e2e/http.e2e.test.ts` ("429 after five wrong tokens, 503 without APPROVAL_TOKEN, 409 approval_expired") |
| AC-30 | `tests/e2e/resilience.e2e.test.ts` ("504 run_timeout with a real abort", "RUN_TIMEOUT_MS is a ceiling even when the run never yields to the event loop (fake without delay)") |
| AC-32 | `tests/e2e/http.e2e.test.ts` ("400 with issues, 404 for unknown scenario", "valid incoming request id is reused; invalid is replaced") |
| AC-33 | `tests/unit/stats.unit.test.ts`; `tests/e2e/http.e2e.test.ts` ("GET /stats after an approved, a rejected and an expired run") |

Demonstrable milestone: the README's `curl` sequence against `npm start`.

## Reference

incident-copilot design document, revision 2, dated 2026-10-04. It lives in the course repository, outside this repository. Sections:

- "4.4 HTTP: Fastify, not Express";
- "5.3 HTTP endpoints";
- "6.1 Error taxonomy";
- "6.9 Observability";
- "8.3 Acceptance criteria in EARS".

Section numbers cited in the criteria (such as "table 4.5.2") point to that document. The status table is in `docs/architecture.md`.
