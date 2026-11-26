# Sentry

Type `sentry`. It has two independent halves, and you can enable either or both:

- **ingest**: it **receives** webhooks of a Sentry internal integration (issue alerts, metric alerts and issue events),
  verifies `Sentry-Hook-Signature` on the raw bytes, and opens (or deduplicates into) a live incident;
- **query**: it **reads** unresolved issues (`query_errors`) and releases (`query_deploys`) over the Sentry REST API
  during the investigation, and, for the [code fixer](../code-fixer.md), an issue's latest event and a release's last
  commit. It has no metrics or logs capability.

Every live incident runs in **shadow mode**: the team investigates and plans, the gate classifies each step by the
catalog, and nothing executes.

Items marked *(unverified)* are not confirmed by the Sentry documentation. The code handles them defensively; see the
last two sections.

## 1. Create an internal integration

1. In Sentry, create an **internal integration** for your organization (Settings, then Developer Settings, then
   Custom Integrations; *unverified*: the menu path and labels change between Sentry versions).
2. Set its **webhook URL** to `https://<host>/ingest/<connectorId>`, where `<connectorId>` is the `id` you will give the
   connector in `copilot.yaml` (for example `https://copilot.example.com/ingest/sentry-prod`). Sentry must reach the
   copilot: when it is not on the same host, set `HOST=0.0.0.0` and `API_TOKEN`, add the public name to `ALLOWED_HOSTS`,
   and behind a reverse proxy set `ingest.trustProxy` to a hop count or your proxy addresses (see `docs/connectors/alertmanager.md`, section 1).

## 2. Choose what Sentry sends

1. Turn on **Alert Rule Action**. Sentry sends `event_alert` (issue alert) and `metric_alert` webhooks only to an
   integration that is an alert action.
2. Under webhooks, subscribe to the **Issue** resource (events `created`, `resolved`, `unresolved`, `assigned`,
   `archived`). The connector acts on `created`, `unresolved` and `resolved` and ignores the rest.

The resources the connector accepts are `event_alert`, `metric_alert` and `issue`; restrict them with
`ingest.resources`. Every other resource (`installation`, `comment`, `error`, `seer`, `preprod_artifact`) is
acknowledged and ignored.

## 3. Give the integration read access

For the query half, grant read permission on **issues and events**, **projects** and **releases** (*unverified*: the
exact permission names). The integration's auth token is what the copilot uses; Sentry recommends an internal
integration token for this.

## 4. Put the secrets in the environment

Copy the integration's **Client Secret** and its **token**:

```sh
export SENTRY_CLIENT_SECRET=<the Client Secret>      # at least 8 characters
export SENTRY_AUTH_TOKEN=<the integration token>     # at least 16 characters
```

Secrets are accepted only as a whole `${VAR}` reference in `copilot.yaml` and join the redaction list.

## 5. Add the integration to your alert rules

In each issue alert rule and each metric alert rule that should open an incident, add an **action** that sends a
notification via the integration. A rule without the action never reaches the copilot. Issue-resource webhooks
(step 2) do not need a rule.

## 6. Configure the copilot

`copilot.yaml` (path in `COPILOT_CONFIG`):

```yaml
version: 1
mode: shadow
services:
  - name: checkout-web              # the canonical name used by the copilot
    aliases:
      sentry-prod: [checkout-web]   # the Sentry PROJECT SLUG
connectors:
  - id: sentry-prod                 # the URL path: /ingest/sentry-prod
    type: sentry
    ingest:
      clientSecret: "${SENTRY_CLIENT_SECRET}"
      # allowedIps: ["203.0.113.10"]                       # optional exact-IP allowlist, checked first
      # resources: [event_alert, metric_alert, issue]      # default: all three
    query:
      organization: my-org                                  # the organization slug
      token: "${SENTRY_AUTH_TOKEN}"
      # baseUrl: https://sentry.io                          # default; an https URL
      # environment: production                             # optional filter for issues and releases
    # severityMap: { fatal: sev1, error: sev2, warning: sev3, critical: sev1 }   # case-insensitive overrides
```

At least one of `ingest` or `query` is required. **Service aliases are Sentry project slugs**: the query half calls
`/projects/<org>/<slug>/...` with the slug the alias resolves to, and refuses a name that is not a plain slug
(`unsafe_input`, no request sent).

## 7. Check and test

```sh
npm run cli -- config check
```

Send a signed fixture (the signature is the HMAC-SHA256 hex digest of the exact bytes of the body):

```sh
BODY=tests/fixtures/connectors/sentry/issue-created.json
SIG=$(openssl dgst -sha256 -hmac "$SENTRY_CLIENT_SECRET" -hex < "$BODY" | sed 's/^.* //')
curl -sS -X POST "http://127.0.0.1:3000/ingest/sentry-prod" \
  -H "Content-Type: application/json" \
  -H "Sentry-Hook-Resource: issue" \
  -H "Sentry-Hook-Signature: $SIG" \
  --data-binary @"$BODY"
```

A missing or wrong signature is 401 and nothing is recorded. A missing `Sentry-Hook-Resource` header is 400.

## The 1-second rule

Sentry expects an answer to a webhook within 1 second. The copilot verifies the signature, records the alert, queues
the run and answers `202` without waiting for the investigation, so the rule holds. If the copilot is down or slow,
Sentry may mark deliveries as failed; the alert state in Sentry is unaffected.

## How a webhook is mapped

The `Sentry-Hook-Resource` header selects the mapping.

| | `event_alert` | `metric_alert` | `issue` |
|---|---|---|---|
| Fires on | action `triggered` | `critical`, `warning` | `created`, `unresolved` |
| Resolves on | never | `resolved` | `resolved` |
| Ignored | other actions | other actions | `assigned`, `archived` and the rest |
| `fingerprint` | `issue:<issue_id>` | `metric_alert:<id>` | `issue:<id>` |
| `externalId` | `event_alert:<event_id>:<triggered_rule>` | `metric_alert:<id>:<action>:<date_closed, date_detected, date_started or receive time>` | `issue:<id>:<action>:<lastSeen or receive time>` |
| `title` | `event.title` | `description_title`, else the alert title, else the rule name | `issue.title` |
| `severity` | `event.level`: fatal sev1, error sev2, warning, info and debug sev3 | `critical` sev1, `warning` sev2 | `issue.level` as for events; priority `high` raises it to at least sev2 |
| `service` | `event.project` when it is a string slug | the first of `projects[]` (a string, or an object's `slug`) | `issue.project.slug` |
| `startedAt` | `event.datetime`, else `event.timestamp`, else the receive time | firing: `date_started`, else `date_detected`; resolved: `date_closed` | firing: `firstSeen`; resolved: the receive time |
| `url` | `event.web_url` | `data.web_url` | `web_url`, else `permalink` |
| `signal` | `error_events` | `other` | `error_events` |
| `attributes` | `triggered_rule`, `level`, `platform`, `issueId` | `aggregate`, `dataset`, `query`, `environment`, `timeWindow` | `shortId`, `culprit`, `status`, `substatus`, `priority`, `count`, `userCount` |

- `event_alert` and `issue` of the same Sentry issue share the fingerprint `issue:<id>`, so they dedupe into one
  incident, and an issue `resolved` webhook resolves it.
- `severityMap` entries win over the defaults for the keys they name (levels for events and issues, `critical` and
  `warning` for metric alerts); the lookup ignores case.
- A resolved alert takes the provider's closing time as `startedAt` when Sentry sends one (metric alerts). Sentry sends
  no closing time for an issue, so the receive time stands in.
- All text is sanitized (control characters removed, `<<<` and `>>>` neutralized, clipped) and reaches the model only
  as alert data.

## How the queries work

Requests are `GET`, with `Authorization: Bearer <token>`, redirects refused and the response size capped.

| Tool | Request | Result |
|---|---|---|
| `query_errors` | `GET <baseUrl>/api/0/projects/<org>/<slug>/issues/?query=is:unresolved&statsPeriod=24h` (plus `environment`) *(unverified)* | up to `limit` issues as error groups: id, title, culprit, level, status, count, user count, first and last seen, last release, permalink |
| `query_deploys` | `GET <baseUrl>/api/0/projects/<org>/<slug>/` once (cached) for the numeric project id *(unverified)*, then `GET <baseUrl>/api/0/organizations/<org>/releases/?project=<id>&per_page=10` (plus `environment`) | releases, newest first, since the requested time: version, time (`lastDeploy.dateFinished`, else `dateReleased`, else `dateCreated`), environment; author, description and URL are null |

If the project id cannot be resolved (for example a 404), releases are listed without `project` (`per_page=100`) and
only those whose `projects[]` include the slug are kept. Auth and rate-limit failures are never swallowed.

Rate limits: Sentry sends `X-Sentry-Rate-Limit-Limit`, `-Remaining` and `-Reset` (epoch seconds) on every response. On
`429` the connector reports `rate_limited` with `Retry-After` when present, otherwise the time until the reset
(never negative, capped at 3600 s). Other failures map to `auth` (401, 403), `unavailable` (5xx, network),
`timeout` and `bad_response` (other statuses, invalid JSON). Errors never contain the token.

The `window` of `query_errors` is not sent to Sentry: the issue list uses a fixed 24-hour period, and the model sees
the first, last and count fields to judge recency.

## Code fixer

Since 0.5 the query half also serves the [code fixer](../code-fixer.md) (spec 009) with two members that are **not** LLM
tools: the model never calls them and never chooses their arguments.

| Member | Requests | Result |
|---|---|---|
| `errorEvent({ service, errorId })` | `GET <baseUrl>/api/0/organizations/<org>/issues/<id>/` (for `firstSeen` and the project), then `GET .../issues/<id>/events/latest/` *(unverified)* | the raised exception (`type`, sanitized `value`), up to 50 stack frames innermost last (`file`, `line`, `column`, `function`, `inApp`), the `release` tag and `firstSeen` |
| `releaseCommit({ service, version })` | `GET <baseUrl>/api/0/organizations/<org>/releases/<version>/` *(unverified)* | `lastCommit.id` (40 hex) and `lastCommit.repository.name` |

- The issue id comes from the alert's fingerprint `issue:<id>`, which the ingest code sets from `event_alert`; it must be
  1 to 20 digits. A release version must match `^[A-Za-z0-9][A-Za-z0-9_.@+:~-]{0,199}$`. Anything else is
  `unsafe_input` before any request. Both are URL-encoded.
- An issue whose `project.slug` is not the service's alias, or a release whose `projects` do not include it, is "no
  data". So is a 404. The fixer then skips (`error_event_unavailable`, `commit_unresolved`).
- The mapper reads only the last exception value's `type`, `value` and `stacktrace.frames[]` (`filename`, else
  `abs_path`; `lineno`, `colno`, `function`, `in_app`), the `release` tag and `firstSeen`. It never reads `vars`,
  `context_line`, `pre_context`, `post_context`, `request`, `user`, `contexts` or `breadcrumbs`, so local variables and
  request data never reach the fixer or its prompts.
- The fixer also needs `deploys` (the releases list above) to check that the error group is new in the failing release.
- For the fixer to resolve a commit, connect your repository in Sentry and associate commits with releases (so
  `lastCommit` is set), or use the commit SHA as the release version (`<name>@<sha>` works: the part after the last `@`
  is used).
- Grant the integration read access to **releases** as well as issues and events (step 3).

## The Sentry hosted MCP server

Sentry hosts an MCP server at `https://mcp.sentry.dev/mcp`. It authenticates with OAuth. The 0.4 `mcp` connector
supports only a static Bearer token or header, so it cannot connect to it. Use this connector's REST query half
instead.

## Facts and sources

From https://docs.sentry.io/organization/integrations/integration-platform/webhooks/ and its issue-alerts, metric-alerts
and issues pages, and https://docs.sentry.io/api/ (checked for 0.4.0):

- Webhook headers: `Content-Type`, `Request-ID`, `Sentry-Hook-Resource`, `Sentry-Hook-Timestamp`,
  `Sentry-Hook-Signature`.
- The signature is the HMAC-SHA256 hex digest of the raw request body keyed with the integration's Client Secret. The
  copilot therefore verifies the exact bytes and never re-serializes.
- A webhook should be answered within 1 second.
- Resources: `installation`, `event_alert`, `issue`, `metric_alert`, `error`, `comment`, `seer`, `preprod_artifact`. The
  body is `{ action, installation: { uuid }, data, actor }`.
- `event_alert`: action is always `triggered`; `data.event` has `event_id`, `issue_id`, `issue_url`, `url`, `web_url`,
  `title`, `platform` and `level`; `data.triggered_rule` names the rule. The integration must be an alert action.
- `metric_alert`: action is `critical`, `warning` or `resolved`; `data` has `description_text`, `description_title`
  and `web_url`; `data.metric_alert` has `id`, `identifier`, `title`, `status`, `projects`, `date_created`,
  `date_detected`, `date_started`, `date_closed` and `alert_rule` (`id`, `name`, `aggregate`, `dataset`, `query`,
  `environment`, `time_window`, and more).
- `issue`: actions `created`, `resolved`, `assigned`, `archived`, `unresolved`; `data.issue` has `url`, `web_url`, `id`,
  `shortId`, `title`, `culprit`, `permalink`, `status`, `substatus`, `level`, `priority`, `platform`, `project`
  (`id`, `name`, `slug`, `platform`), `count` (a string), `userCount`, `firstSeen` and `lastSeen`.
- REST: base `https://sentry.io/api/0/`, `Authorization: Bearer <token>`; the internal integration token is
  recommended. Retrieve an issue is `GET /api/0/organizations/{org}/issues/{issue_id}/`, its latest event is
  `.../issues/{issue_id}/events/latest/`, and releases are `GET /api/0/organizations/{org}/releases/` with the query
  parameters `project`, `environment` and `per_page` (at most 100) and the fields `version`, `dateReleased`,
  `dateCreated`, `lastDeploy` and `projects`.
- Every API response carries `X-Sentry-Rate-Limit-Limit`, `-Remaining` and `-Reset` (epoch seconds).
- Code fixer (checked for 0.5.0): an issue's latest event has `entries[]`, where the entry of `type: "exception"` holds
  `data.values[]` with `type`, `value` and `stacktrace.frames[]` (innermost last), and `tags[]` as `{ key, value }`
  pairs including `release`. Retrieve a release is `GET /api/0/organizations/{org}/releases/{version}/`, with
  `lastCommit` and `projects`.

The fixtures in `tests/fixtures/connectors/sentry/` are built from these field tables and the abridged examples, not
captured from Sentry.

## Unverified

Handled defensively, not relied upon:

- The full verbatim `event_alert` and `metric_alert` payloads. Every field is optional in the parser; an alert without
  an issue or metric alert id is rejected as invalid, the rest falls back (title, receive time, no service).
- Which `event_alert` field carries the project. The connector reads `data.event.project` (a string slug, or an object
  with a `slug`). A numeric id is not a slug and gives no service, so the alert cannot be routed by alias. Event
  timestamps are read from `datetime`, then `timestamp`.
- The type of `metric_alert.projects` entries (slug strings or objects): both are accepted.
- The issue list endpoint. The connector calls `GET /api/0/projects/{org}/{project}/issues/` with `query` and
  `statsPeriod`; the alternative is `GET /api/0/organizations/{org}/issues/?query=...&statsPeriod=...`. The URL builder
  is isolated in `src/connectors/sentry/query.ts` (`projectIssuesUrl`).
- The project detail endpoint `GET /api/0/projects/{org}/{project}/` returning a numeric `id`, and whether the
  releases `project` parameter takes that numeric id; hence the fallback to an unfiltered release list.
- Whether a `429` carries `Retry-After`; the reset header is the fallback.
- Regional hosts (`us.sentry.io`, `de.sentry.io`): set `query.baseUrl` to your region's URL if `sentry.io` does not
  serve your organization.
- Whether `Sentry-Hook-Timestamp` is signed. The documentation says the signature covers the body, so the timestamp is
  not part of the digest, and the connector does not enforce a replay window; the copilot's idempotency on
  `externalId` absorbs a replayed delivery.
- The Developer Settings UI path and the permission names in steps 1 and 3.
- Code fixer: the issue detail, latest event and release detail paths, and their field names. In particular the
  casing of frame fields (`lineno` or `lineNo`, `in_app` or `inApp`, `abs_path` or `absPath`): the mapper reads the
  snake_case names only, so a camelCase-only response gives no frames and the fixer skips with `no_in_app_frame`
  instead of guessing. A top-level `exception.values` is accepted when there is no `entries[]`.
- Code fixer: whether `lastCommit.repository.name` is the `owner/name` the fixer allowlists. When it is not, the
  fixer falls back to a 40-hex release version or skips with `commit_unresolved`.
- Code fixer: whether the latest event of an issue is the event that fired the alert. The fixer only needs one event
  of the error group, and it requires the group to be new in the event's release.
