# Bugsnag (SmartBear Insight Hub)

Type `bugsnag`. It does two things, each optional but at least one required:

- **Ingest**: a Bugsnag [Data Forwarding webhook](https://docs.bugsnag.com/product/integrations/data-forwarding/webhook/)
  opens (or deduplicates into) a live incident, and resolves it when the error is marked fixed.
- **Query**: the Data Access API v2 gives the investigation the error groups and the releases of a project
  (`query_errors` and `list_deploys`). There are no metrics, no logs and no external tools.

Every live incident runs in **shadow mode**: the team investigates and plans, the gate classifies each step by the
catalog, and nothing executes.

> **How the webhook is authenticated.** Bugsnag documents no signature, secret, HMAC, basic authentication or custom
> header for this webhook. The copilot therefore authenticates it with a **secret token in the URL path**
> (`/ingest/<connectorId>/<token>`) and, optionally, Bugsnag's published source IPs. There is no HMAC for this type, and a
> token sent in a header or a query string is not accepted.

## 1. Generate a webhook token

```sh
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
```

The token must be 24 to 128 characters of `A-Z a-z 0-9 _ -` (it goes into a URL path); the command above gives 32.

## 2. Put it in the copilot's environment

```sh
export BUGSNAG_WEBHOOK_TOKEN=<the value>
```

The config refers to it as `"${BUGSNAG_WEBHOOK_TOKEN}"`; a literal token in `copilot.yaml` is refused.

## 3. Add the Data Forwarding webhook in Bugsnag

In the Bugsnag dashboard, open the **project settings**, then **Data forwarding** (the label and menu position may differ
between dashboard versions; this path is not confirmed), add a **Webhook** and set:

- URL: `https://<host>/ingest/<connectorId>/<token>`, where `<connectorId>` is the `id` of the entry in `copilot.yaml`
  (for example `bugsnag`) and `<token>` is the value from step 1.
- Triggers: choose the ones you want an incident for. The copilot understands `exception`, `firstException`,
  `errorEventFrequency`, `powerTen`, `projectSpiking`, `reopened` and `errorStateManualChange` (the default set). Bugsnag
  also sends `comment`, `release`, `projectSamplingStarted` and `projectApproachingRateLimit`; the copilot always
  acknowledges and ignores those.

The URL is a credential. Anyone who has it can open incidents, so use https, never paste it in a ticket or chat, and
**rotate** it if it leaks: generate a new token, update the environment variable and the Bugsnag URL, restart the copilot.
The copilot adds the token to its redaction list, so it is masked in logs (the access log records the request path), traces, errors and every response; keep the URL out of proxy and load balancer access logs too.

## 4. Optional: restrict the source IPs

Bugsnag lists these source addresses for the webhook:

```
104.196.245.109  104.196.254.247  107.23.160.224  34.231.155.113
34.235.33.231    52.207.146.211   52.55.78.127
```

For Bugsnag On-premise the source is your own installation (the documentation points to its "Remote proxy URL" setting),
so use your own addresses. Put them in `allowedIps` (below). The check runs before the token. An IPv4 address that the
socket reports in IPv6 form (`::ffff:52.55.78.127`) is matched as the IPv4 address, in the list and in the request.

Behind a reverse proxy or a load balancer the socket address is the proxy's, not Bugsnag's. Set `trustProxy`
under the top-level `ingest:` settings of `copilot.yaml` to the number of proxies in front of the copilot (`1` for one)
or to their addresses, so the copilot reads the client address from the proxy's forwarded header. Plain `true` is
refused, because it would let a client choose its own address. Without `trustProxy`, leave `allowedIps` out and rely on
the token.

## 5. Create a personal auth token for the Data Access API

In Bugsnag, open **My account > Personal auth tokens** and create a token. It gives read access to what your user can
see, so prefer a dedicated user with access to the projects you need. Put it in the environment:

```sh
export BUGSNAG_API_TOKEN=<the value>
```

Choose `baseUrl` by the host of your dashboard:

| Dashboard | `baseUrl` |
|---|---|
| Bugsnag on `app.bugsnag.com` | `https://api.bugsnag.com` (the default) |
| Insight Hub on SmartBear's domain | `https://api.bugsnag.smartbear.com` |
| Bugsnag On-premise | your installation's API address (https; `http` only for localhost) |

Which of the first two hosts applies to a given account is not confirmed by the documentation: if the first request fails
with an authentication error, try the other.

## 6. Find the project ids

The query side needs each project's id. List them with the Data Access API (the "organizations" and "projects"
operations; the exact paths are not confirmed, these are the usual ones):

```sh
curl -sS -H "Authorization: token $BUGSNAG_API_TOKEN" -H "X-Version: 2" https://api.bugsnag.com/user/organizations
curl -sS -H "Authorization: token $BUGSNAG_API_TOKEN" -H "X-Version: 2" https://api.bugsnag.com/organizations/<organization id>/projects
```

Each project has an `id` (24 hex characters) and a `name`. Alternatively the id is in `project.id` of any webhook payload.

## 7. Configure the copilot

`copilot.yaml` (path in `COPILOT_CONFIG`):

```yaml
version: 1
mode: shadow
services:
  - name: checkout-api                # the canonical name used by the copilot
    aliases:
      bugsnag: [checkout-api]         # the Bugsnag project name (project.name in the webhook; the key under query.projects)
connectors:
  - id: bugsnag                       # the URL path: /ingest/bugsnag/<token>
    type: bugsnag
    ingest:
      token: "${BUGSNAG_WEBHOOK_TOKEN}"
      # allowedIps: [52.55.78.127, 34.231.155.113]
      # triggers: [exception, firstException, errorEventFrequency, powerTen, projectSpiking, reopened, errorStateManualChange]
    query:
      # baseUrl: https://api.bugsnag.com
      token: "${BUGSNAG_API_TOKEN}"
      projects:
        checkout-api: 5f1c2a3b4d5e6f7a8b9c0d2f    # alias (Bugsnag project name) -> project id
    # severityMap: { error: sev2, warning: sev3, info: sev3 }   # keys are the Bugsnag error severities
```

Use `ingest` only, `query` only, or both. Then check the file:

```sh
npm run cli -- config check
```

The service name of an alert is `project.name`; the alias of a project in `query.projects` is matched, ignoring case,
against the connector's alias of the canonical service. A service with no project in `query.projects` gets an empty
answer (not an error).

## 8. Test with curl

```sh
curl -sS -X POST "http://127.0.0.1:3000/ingest/bugsnag/$BUGSNAG_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @tests/fixtures/connectors/bugsnag/exception.json
# 202 {"accepted":1,"duplicates":0,...}
```

Without the token in the path, or with a wrong one, the answer is 401 `invalid_webhook_credentials` and nothing is recorded.

## How a webhook is mapped

| NormalizedAlert | From |
|---|---|
| `externalId` | `<trigger.type>:<error.id or project.id>:<error.receivedAt or the receive time>`; for `errorStateManualChange` the `stateChange` is added after the type |
| `fingerprint` | `error:<error.errorId>` (else `error.id`); `spike:<project.id>` for `projectSpiking` |
| `status` | `firing`; `resolved` for `errorStateManualChange` with `stateChange: fixed`. `reopened` and `unignored` fire again; `snoozed`, `snoozeCancelled`, `ignored` and any other value are ignored |
| `service` | `project.name`, then mapped through `services[].aliases.<id>` |
| `title` | `<exceptionClass>: <message>` (else the first of `error.exceptions`), else `trigger.message`, else "Bugsnag alert"; clipped to 200 |
| `severity` | `error.severity` through `severityMap` (default `error` sev2, `warning` and `info` sev3); `projectSpiking` without a severity is sev2 |
| `startedAt` | `error.receivedAt`, else `error.firstReceived`, else the receive time |
| `url` | `error.url`, else `project.url` (http or https only) |
| `signal` | `error_events` |
| `attributes` | `trigger`, `stateChange`, `triggerMessage`, `releaseStage`, `appVersion`, `context`, `exceptionClass`, `unhandled`, `status` |

The fingerprint is the same for every trigger about the same error, so an `exception` followed by a `powerTen` for the same
error joins the open incident instead of opening another. All text is sanitized (control characters removed, `<<<` and
`>>>` neutralized, clipped) and reaches the model only as alert data.

A fixed, reopened and fixed again error produces the same `externalId` for the second `fixed` when Bugsnag sends the
same `error.receivedAt` (the time of the latest event, which does not change when someone marks the error). That second
`fixed` is counted as a duplicate.

## What the investigation reads

| Tool | Request | Mapped to |
|---|---|---|
| `query_errors` | `GET <baseUrl>/projects/<id>/errors?sort=last_seen&direction=desc&per_page=<limit>` (limit capped at 100) | `error_class: message` as the title, `context` as culprit, `severity` as level, `status`, `events` as count, `users` as user count, `first_seen`, `last_seen` |
| `list_deploys` | `GET <baseUrl>/projects/<id>/releases?per_page=10` | `app_version` (else `version`) and `release_time` (else `released_at`) and `release_stage`, filtered to releases at or after `since`, newest first |

Both send `Authorization: token <token>` (the word `token`, not `Bearer`) and `X-Version: 2`. A 401 or 403 is an
authentication failure, a 429 is a rate limit (with the `Retry-After` seconds), a 5xx or a network failure is
"unavailable", and anything else unexpected is a malformed response; the investigation sees a fixed short text, never the
body or the token. The URLs are built in one function, `bugsnagUrls` in `src/connectors/bugsnag/query.ts`, so a wrong path
or parameter is a one-line fix. Pagination is not followed: the copilot asks for one page.

## Facts and sources

From the Bugsnag documentation (checked for 0.4.0):

- Webhook ([Data Forwarding: Webhook](https://docs.bugsnag.com/product/integrations/data-forwarding/webhook/)): a JSON `POST`,
  configured per project and filtered by trigger type. No signature, secret, HMAC, basic authentication or custom header
  is documented; the only access control is an IP allowlist (the addresses above; for On-premise, the "Remote proxy URL"
  setting).
- `trigger.type` values: `projectSpiking`, `release`, `projectSamplingStarted`, `projectApproachingRateLimit`,
  `firstException`, `errorEventFrequency`, `powerTen`, `exception`, `reopened`, `comment`, `errorStateManualChange`.
  `trigger.stateChange` values: `fixed`, `reopened`, `snoozed`, `snoozeCancelled`, `ignored`, `unignored`.
- Payload: `account`, `project` and `trigger` are always present; `error` and `release` are optional. `error` always has
  `id`, `errorId`, `exceptionClass`, `message`, `context`, `firstReceived`, `receivedAt`, `url`, `severity` (`error`,
  `warning` or `info`), `status` (`open`, `fixed`, `snoozed` or `ignored`) and `app` (with `releaseStage`); `unhandled`
  and `exceptions[]` (`errorClass`, `message`, `type`, `stacktrace[]`) are optional. In the official example the stack
  trace `lineNumber` values are strings and the example is JavaScript-like rather than strict JSON.
- Data Access API v2 ([base server URL](https://developer.smartbear.com/bugsnag/docs/data-access-base-server-url),
  authentication, versioning, pagination and rate limiting pages): base `https://api.bugsnag.com`,
  `https://api.bugsnag.smartbear.com` or an on-premise host; header `Authorization: token <TOKEN>` and `X-Version: 2`;
  default page size 30, `per_page` up to about 100, the `Link` header for the next page; `X-RateLimit-Limit` and
  `X-RateLimit-Remaining` headers, and 429 with `Retry-After` in seconds. Operations exist to list the errors of a
  project, view an error, view the latest event of an error and list the releases of a project.

## Unverified

Handled defensively, not relied upon (the fixtures under `tests/fixtures/connectors/bugsnag/` follow these assumptions
and their values are illustrative):

- The exact paths `GET /projects/{project_id}/errors` and `GET /projects/{project_id}/releases` (inferred from secondary
  sources), the list parameters `sort`, `direction` and `per_page`, and any filter syntax.
- The response field names. snake_case is assumed (`error_class`, `message`, `context`, `severity`, `status`, `events`,
  `users`, `first_seen`, `last_seen`; releases: `app_version` or `version`, `release_time` or `released_at`,
  `release_stage`); camelCase variants are read when the snake_case key is missing, and a row that cannot be read is
  dropped instead of failing the call. The error group `url` and `release` are always empty for that reason.
- Whether `error.id` is the event and `error.errorId` the error group. The connector assumes `errorId` is the group and
  falls back to `id` when it is missing.
- The webhook's retry behavior, timeout, `Content-Type` and `User-Agent`. The copilot answers 202 fast and is idempotent on
  `externalId`, so a retry is counted as a duplicate; it does not depend on a header.
- Whether `api.bugsnag.com` or `api.bugsnag.smartbear.com` applies to your account, and the paths of the organizations and
  projects operations used in step 6.
- The dashboard path to Data forwarding and to Personal auth tokens.
