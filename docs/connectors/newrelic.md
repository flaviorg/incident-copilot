# New Relic

Type `newrelic`. It does two independent jobs, and an entry may enable either or both:

- **Ingest.** A New Relic workflow sends an issue to the copilot through a webhook destination. An `ACTIVATED` or
  `CREATED` issue opens (or deduplicates into) a live incident; a `CLOSED` issue resolves it.
- **Query.** During the investigation the copilot reads metrics, error groups, logs and deployments from New Relic
  through NerdGraph (NRQL). The queries come from templates you control; the model never writes NRQL.

Every live incident runs in **shadow mode**: the team investigates and plans, the gate classifies each step by the
catalog, and nothing executes.

## 1. Create the webhook destination

In New Relic: **Alerts > Destinations > Add a destination > Webhook**.

- Endpoint URL: `https://<host>/ingest/<connectorId>`, where `<connectorId>` is the `id` of the entry in `copilot.yaml`
  (below it is `nr`). New Relic must be able to reach the copilot: put it behind HTTPS, add its public hostname to
  `ALLOWED_HOSTS`, and set `API_TOKEN` when `HOST` is not loopback (`/ingest/*` does not use `API_TOKEN`; every other
  route does). Behind a reverse proxy, set `ingest.trustProxy` in `copilot.yaml` (a hop count such as `1`, or your proxy addresses; see `docs/connectors/alertmanager.md`, section 1).
- Authentication, one of:
  - **Use authorization** with **Bearer Token** (recommended): the token is a secret you generate, at least 16
    characters (`node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"`);
  - **Use authorization** with **Basic Authentication**;
  - a **custom header** (for example `x-copilot-token: <secret>`). New Relic encrypts custom header values.

New Relic documents no request signing, so this connector never claims signature verification: the destination's
credential is the only proof of origin. Optionally add `allowedIps` to the entry, with the source addresses of your New
Relic region.

## 2. Create the workflow and paste the template

**Alerts > Workflows > Add a workflow.** Filter the issues you want (for example one policy), then add the webhook
destination as a notification channel. Notify on **Activated** and **Closed** (both notify all destinations). In the
payload box paste this template, which uses only documented issue variables:

```handlebars
{
  "issueId": {{json issueId}},
  "title": {{json issueTitle}},
  "priority": {{json priority}},
  "state": {{json state}},
  "triggerEvent": {{json triggerEvent}},
  "issuePageUrl": {{json issuePageUrl}},
  "createdAt": {{json createdAt}},
  "updatedAt": {{json updatedAt}},
  "closedAt": {{#if closedAt}}{{json closedAt}}{{else}}null{{/if}},
  "entitiesData": {{json entitiesData}},
  "conditionName": {{json accumulations.conditionName.[0]}},
  "policyName": {{json accumulations.policyName.[0]}},
  "workflowName": {{json workflowName}}
}
```

- The payload is a Handlebars JSON template; New Relic refuses to save an invalid one. Use the **preview** pane and check
  that the rendered JSON has a real `issueId`, `state` and `entitiesData`.
- The two `accumulations` lines index a list with the `.[0]` syntax. The New Relic documentation shows the
  `conditionName[0]` form; the bracket syntax in a template is unverified. If saving fails or the preview shows
  an empty value, delete those two lines: the connector works without them (they only add the `conditionName` and
  `policyName` attributes).
- There is no variable named plain `title`: the issue title is `issueTitle`, sent here as `title`.

## 3. Create a user API key for the queries (optional)

Skip this step if you only want ingest.

1. **User menu > API keys > Create a key**, key type **User**. It starts with `NRAK-`.
2. Use a dedicated user with the least privilege that can run NRQL on the one account (read-only access to that
   account's data). Do not reuse a key with admin or write access.
3. Note the **account id** (a positive integer) and the **region** of that account: `us` (`api.newrelic.com`) or `eu`
   (`api.eu.newrelic.com`).
4. Export the key in the copilot's environment, for example `NEW_RELIC_API_KEY`. Secrets are accepted only as a whole
   `${VAR}` reference of at least 16 characters.

## 4. Configure the copilot

`copilot.yaml` (path in `COPILOT_CONFIG`):

```yaml
version: 1
mode: shadow
services:
  - name: checkout-api                 # the canonical name used by the copilot
    aliases:
      nr: ["Checkout API (prod)"]      # the entity name in New Relic (see below)
connectors:
  - id: nr                             # the URL path: /ingest/nr
    type: newrelic
    ingest:
      auth: { type: bearer, token: "${NEW_RELIC_WEBHOOK_TOKEN}" }
      # or: { type: basic, username: newrelic, password: "${NEW_RELIC_WEBHOOK_PASSWORD}" }
      # or: { type: header, name: x-copilot-token, value: "${NEW_RELIC_WEBHOOK_TOKEN}" }
    query:
      region: us                       # us (default) or eu
      accountId: 1234567
      apiKey: "${NEW_RELIC_API_KEY}"
      # nrql: see "NRQL templates" below
    # severityMap: { CRITICAL: sev1, HIGH: sev2, MEDIUM: sev3, LOW: sev3 }   # the default; case-insensitive
```

At least one of `ingest` or `query` is required. Unknown keys are refused.

**Service aliases.** An issue carries the names of the entities involved (for an APM application, its name). The first
entity name is the alert's `service`, and `services[].aliases.nr` maps it to the canonical service. The same alias is
what the copilot puts into the NRQL `{service}` placeholder, so it must be the entity name your templates compare
against (`appName` or `service.name`). An alias must match `^[A-Za-z0-9 ._:/()\[\]-]{1,120}$`; one with a quote or any
other character is refused with `unsafe_input` and never sent to New Relic.

## 5. Check the file

```sh
npm run cli -- config check
```

It validates the file (including the NRQL templates) and lists each connector with its capabilities. Then run a test
notification from the workflow and look at `GET /ingest/alerts`, or post a fixture by hand:

```sh
curl -sS -X POST "http://127.0.0.1:3000/ingest/nr" \
  -H "Authorization: Bearer $NEW_RELIC_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @tests/fixtures/connectors/newrelic/issue-activated.json
```

The fixtures are built from the documented template, not captured from New Relic (see their README).

## How a payload is mapped

| NormalizedAlert | From |
|---|---|
| `externalId` | `<issueId>:<state>:<updatedAt, else createdAt, else the receive time>` |
| `fingerprint` | `issue:<issueId>` |
| `status` | `state`: `CLOSED` is `resolved`; `ACTIVATED` and `CREATED` are `firing`; any other state is ignored |
| `title` | `title`, else `New Relic issue <issueId>` |
| `severity` | `priority` through `severityMap` (default `CRITICAL` sev1, `HIGH` sev2, `MEDIUM` and `LOW` sev3; unknown or missing is sev2) |
| `startedAt` | firing: `createdAt`; resolved: `closedAt`, else `updatedAt` (the provider's close time becomes the incident's resolution time); the receive time when missing or unreadable |
| `service` | the first entity name of `entitiesData`, then mapped through `services[].aliases.<id>` |
| `url` | `issuePageUrl` when it is http(s) |
| `signal` | `other` |
| `attributes` | `priority`, `state`, `triggerEvent`, `workflowName`, `conditionName`, `policyName`, `entityType` |

- `issueId` (a string or a number) is required; a body without it, or that is not a JSON object, is 400
  `invalid_payload`.
- Timestamps may be epoch milliseconds, epoch seconds, numeric strings or ISO 8601 strings.
- `entitiesData` may be `{ "names": [...] }`, `{ "entities": [{ "name": ... }] }`, an array of `{ "name": ... }`, an
  array of strings or a plain string.
- All text is sanitized (control characters removed, `<<<` and `>>>` neutralized, clipped) and reaches the model only
  as alert data.

## NRQL templates

The copilot has four query tools. With a `query` block, New Relic provides them with these default templates, which
you can override one by one under `query.nrql`:

| Tool | Default template |
|---|---|
| metric `error_rate` | `SELECT percentage(count(*), WHERE error IS true) FROM Transaction WHERE appName = '{service}' SINCE {since} UNTIL {until} TIMESERIES` |
| metric `latency_p99` | `SELECT percentile(duration, 99) FROM Transaction WHERE appName = '{service}' SINCE {since} UNTIL {until} TIMESERIES` |
| metric `throughput` | `SELECT rate(count(*), 1 minute) FROM Transaction WHERE appName = '{service}' SINCE {since} UNTIL {until} TIMESERIES` |
| errors | `SELECT count(*) FROM TransactionError WHERE appName = '{service}' FACET error.class, error.message SINCE {since} UNTIL {until} LIMIT {limit}` |
| logs | `SELECT timestamp, level, message FROM Log WHERE service.name = '{service}' AND level = '{level}' SINCE {since} UNTIL {until} LIMIT {limit}` |
| deploys | `SELECT timestamp, version, user, description FROM Deployment WHERE appName = '{service}' SINCE {since} LIMIT 10` |

**The defaults are best effort and unverified.** The event types (`Transaction`, `TransactionError`, `Log`,
`Deployment`), the attribute names and whether `SINCE` accepts epoch milliseconds were not checked against a real
account. Test each one in the New Relic query builder (replace the placeholders by hand) and override what does not
fit your data:

```yaml
    query:
      region: eu
      accountId: 1234567
      apiKey: "${NEW_RELIC_API_KEY}"
      nrql:
        metrics:                       # adds metrics, or overrides a default by name; names match ^[a-z][a-z0-9_]{0,31}$
          error_rate: "SELECT percentage(count(*), WHERE error IS true) FROM Transaction WHERE entity.name = '{service}' SINCE {since} UNTIL {until} TIMESERIES"
          apdex: "SELECT apdex(duration, t: 0.5) FROM Transaction WHERE appName = '{service}' SINCE {since} UNTIL {until} TIMESERIES"
        errors: "SELECT count(*) FROM TransactionError WHERE entity.name = '{service}' FACET error.class, error.message SINCE {since} UNTIL {until} LIMIT {limit}"
        logs: null                     # null turns the capability off (the tool is not offered for this source)
        deploys: null
```

Rules, checked when the file loads:

- A template starts with `SELECT` or `FROM` (any case) and contains `{service}`, always inside single quotes.
- Placeholders: `{service}`, `{since}` and `{until}` (epoch milliseconds, integers), `{limit}` (integer), `{level}`
  (`ERROR` or `WARN`, logs only). `{limit}` is not available to metrics. Any other `{name}` is refused.
- Metric templates are expected to be `TIMESERIES` queries.

**Injection safety.** The model supplies a service, a metric name from the configured list and a window; it never
supplies NRQL. Before substitution `{service}` must match `^[A-Za-z0-9 ._:/()\[\]-]{1,120}$` (no quote, backslash,
`=`, newline or other character), numbers must be safe integers, and the level is `ERROR` or `WARN`; anything else is a
`ConnectorError("unsafe_input")` and no request is sent. The query text travels as a GraphQL variable, never spliced
into the GraphQL document.

Result mapping (defensive: a row that cannot be read is skipped, a response of the wrong shape is `bad_response`):

- metrics: `beginTimeSeconds * 1000` is the timestamp; the value is the first numeric leaf that is not
  `beginTimeSeconds` or `endTimeSeconds`, searching nested objects; at most the latest 500 points;
- errors: the title is `<error.class>: <error.message>` from the `facet` array or from the `error.class` and
  `error.message` keys; `count` comes from the `count` key; the id is a hash of the facet;
- logs: `timestamp`, `level` and `message`; deploys: `timestamp`, `version`, `user` (the author) and `description`.

HTTP errors map through the shared client: 401 and 403 are `auth`, 429 is `rate_limited` (with `Retry-After`), 5xx is
`unavailable`, a GraphQL `errors` array is `bad_response`. No error text contains the API key.

## 6. Troubleshooting

- **The copilot answers 401 `invalid_webhook_credentials`.** The destination's credential differs from the entry's.
  For a header destination the header name is compared in lower case.
- **421.** The destination's hostname is missing from `ALLOWED_HOSTS`.
- **400 `invalid_payload`.** The rendered payload has no `issueId`. Open the issue in New Relic and check the
  **notification log** of the issue: it shows the payload that was sent and the response status.
- **The payload is accepted but nothing opens.** The `state` was not `CREATED`, `ACTIVATED` or `CLOSED` (answer
  `ignored`), or a `CLOSED` issue had no open incident (also `ignored`).
- **The alert has no service.** `entitiesData` rendered empty or in a shape that holds no name; check the preview. The
  copilot opens the incident without a service and the investigation tools have nothing to scope to.
- **A query tool answers `unsafe_input`.** The service alias contains a character outside the allowlist.
- **A query tool answers `bad_response`.** NerdGraph returned an `errors` array, usually an invalid NRQL (a default
  template that does not match your data). Run the rendered query in New Relic and fix the template.
- **`auth`.** The user key is wrong, belongs to another region, or lacks access to the account.

## Alternative: the New Relic MCP server

Instead of (or besides) the NRQL query capability you can use New Relic's MCP server as a data source through the
generic `mcp` connector; see [mcp.md](mcp.md) for its allowlist and read-only rules.

- Endpoint: `https://mcp.newrelic.com/mcp/` (EU accounts: `https://mcp.eu.newrelic.com/mcp/`).
- Header `api-key` with a user API key; header `include-tags` selects tool groups, for example
  `data-access,incident-response`.
- An administrator must enable **API Keys for the MCP server** in New Relic's feature control, or the key is refused.
- Whether a generic MCP client can authenticate with the API key is unverified, and tools that require OAuth are not
  usable this way. List the tools first and allowlist only read-only ones.

Ingest still needs this connector: the MCP server does not send webhooks.

## Facts and sources

Checked for 0.4.0 (as documented; none of it was exercised against a real account):

- Webhook destinations: https://docs.newrelic.com/docs/alerts/get-notified/notification-integrations/
  - New Relic sends an HTTP POST; **Use authorization** offers Basic Authentication or a Bearer Token; custom headers
    are supported and their values are encrypted.
  - The payload is a Handlebars JSON template; an invalid JSON template cannot be saved; the `json` helper is the way to
    emit a value (for example `{{json issuePageUrl}}`).
  - Activated and Closed notify all destinations.
  - No request signing or HMAC is documented.
- Issue variables: https://docs.newrelic.com/docs/alerts/get-notified/custom-variables-incident-workflows
  - `issueId`, `issueTitle`, `priority` (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`), `state` (`CREATED`, `ACTIVATED`,
    `CLOSED`), `issuePageUrl`, `createdAt`, `activatedAt`, `closedAt` (null while open), `updatedAt`, `triggerEvent`,
    `workflowName`, `entitiesData.names`, `entitiesData.types` and `entitiesData.entities`;
  - `accumulations.conditionName[0]` and `accumulations.policyName[0]` appear in the Microsoft Teams template;
  - there is no variable named plain `title`.
- NerdGraph: https://docs.newrelic.com/docs/apis/nerdgraph/get-started/introduction-new-relic-nerdgraph/
  - `POST https://api.newrelic.com/graphql` (US) or `https://api.eu.newrelic.com/graphql` (EU), headers
    `API-Key: <user key>` and `Content-Type: application/json`, body `{ "query": ..., "variables": ... }`.
- NRQL through NerdGraph: https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-nrql-tutorial/
  - `{ actor { account(id: ID) { nrql(query: "...") { results } } } }`.
- MCP server: https://mcp.newrelic.com/mcp/ and https://mcp.eu.newrelic.com/mcp/ (headers `api-key` and `include-tags`).

## Unverified

Handled defensively, not relied upon:

- The scalar type name of the `nrql` argument in the query document (`$nrql: Nrql!` is used, after the NRQL tutorial).
- The rendered shape of `{{json entitiesData}}`: the parser accepts `{names}`, `{entities}`, arrays of objects or of
  strings, and a string.
- Whether `createdAt`, `updatedAt` and `closedAt` are epoch milliseconds or strings: epoch milliseconds, epoch seconds,
  numeric strings and ISO strings are all accepted.
- The Handlebars array-index syntax `accumulations.conditionName.[0]` (the docs show `conditionName[0]`); delete the
  two lines if it does not work.
- The exact field names of the Basic and Bearer options in the destination form.
- The row shape of a `TIMESERIES` result (`beginTimeSeconds`, `endTimeSeconds` and a value, possibly nested) and of
  `FACET` rows (`facet` array or the attribute keys).
- Every default NRQL template: event types, attribute names, and whether `SINCE` and `UNTIL` accept epoch milliseconds.
- Whether the MCP server accepts an API key from a generic client.
