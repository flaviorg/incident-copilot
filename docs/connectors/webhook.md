# Generic JSON webhook

Type `webhook`. Any tool that can POST JSON (an internal monitor, a cron job, a vendor without a dedicated
connector) can open, deduplicate and resolve live incidents. You tell the copilot where each alert field lives in the
body, in `copilot.yaml`. It has no query capability: pair it with a data source connector for the investigation tools.

Every live incident runs in **shadow mode**: the team investigates and plans, the gate classifies each step by the
catalog, and nothing executes.

## 1. Choose an authentication scheme

Authentication is mandatory; the connector does not load without `ingest.auth`. Secrets are accepted only as a whole
`${VAR}` reference to an environment variable of at least 16 characters (24 for `path_token`), and the value never
appears in logs or errors. Every comparison is constant-time.

| `auth.type` | The sender provides | Use when |
|---|---|---|
| `hmac` (recommended) | A signature of the **raw body** in a header | The sender can compute an HMAC. It proves who sent the request and that the body was not altered |
| `bearer` | `Authorization: Bearer <token>` | The sender can set one header |
| `basic` | `Authorization: Basic base64(user:password)` | The sender only supports HTTP basic auth |
| `header` | A custom header (`name`) with an exact `value` | The sender can add one fixed header |
| `path_token` | The token as the last URL segment: `/ingest/<id>/<token>` | The sender can only call a URL (the token ends up in proxy and access logs: treat it as weaker) |

Each scheme also accepts `allowedIps` (exact addresses, checked before any credential). Behind a reverse proxy set
`ingest.trustProxy` in `copilot.yaml` to the number of proxies in front of the copilot (for example `1`), or to the list of their addresses or CIDR ranges, so the source address is the client's (plain `true` is refused: see [alertmanager.md](alertmanager.md#1-choose-a-token-and-expose-the-copilot)). Reaching the copilot from another
host also needs `HOST`, `API_TOKEN` and `ALLOWED_HOSTS`, as in [alertmanager.md](alertmanager.md#1-choose-a-token-and-expose-the-copilot).

For `hmac`: `header` is the lower-case header name, `algorithm` is `sha256` (default) or `sha1`, `encoding` is `hex`
(default) or `base64`, and `prefix` is text the sender puts before the digest (for example `sha256=`). The digest is
computed over the exact bytes of the request body, so the sender must sign the same bytes it sends.

## 2. Write the mapping

`ingest.mapping` maps body fields to the normalized alert. A **path** is dot-separated; numeric segments are array
indexes (`items.0.id`). At load time a path may use letters, digits, `_` and `-`, has at most 10 segments, and never
contains `__proto__`, `constructor` or `prototype`. Values that are numbers or booleans are converted to text.

| Key | Required | Meaning |
|---|---|---|
| `alerts` | no | Path to an array; each element is one alert. Without it, the body itself is one alert |
| `externalId` | yes | Idempotency key of the **event** (see the warning below) |
| `fingerprint` | no | Groups events of the same problem. Default: the `externalId` value |
| `service` | no | Path to the service name; mapped to a canonical service through `services[].aliases.<connector id>` |
| `title` | yes | A path, or `{ template: "text with {path.to.field}" }`: at most 10 placeholders; a missing value renders empty; if none resolves the element is skipped |
| `severity` | no | `{ path, map: { value: sev1\|sev2\|sev3 }, default: sev3 }`; matching ignores case. The entry's own `severityMap` covers values `map` does not list |
| `status` | no | `{ path, resolvedValues: [...] }`, matched ignoring case, default `[resolved, ok, closed]`. Any other value, or no value, means firing. Without `status` every alert is firing |
| `startedAt` | no | ISO-8601, epoch milliseconds or epoch seconds. Default: the time the copilot received the request |
| `url` | no | Link to the alert, kept only when http(s) |
| `signal` | no | What the alert measures: `http_5xx_rate`, `p99_latency_ms`, `request_rate`, `daily_cost_usd`, `projected_monthly_cost_usd`, `error_events` or `other` (default) |
| `attributes` | no | `{ name: path }`, at most 20 (names of 1 to 64 characters from `A-Za-z0-9_.:-`); missing or non-scalar values are left out |

`maxAlertsPerRequest` (1 to 100, default 20) sits beside `auth` and `mapping`. Elements beyond it are dropped and the
count is recorded in the attribute `truncated` of the first alert.

An element without a usable `externalId` or `title` is skipped. When every element is skipped the request is
answered 400 `invalid_payload` with issues that name the mapping key (for example `mapping.externalId: no usable value
in the payload`), never a value. An `alerts` path that does not hold an array is also 400; an empty array is
acknowledged as ignored. All text is sanitized (control characters removed, `<<<` and `>>>` neutralized, clipped to
200 characters for titles, 500 for attribute values).

> **Resolving needs two stable ids.** The copilot stores one row per `externalId` and drops a repeat as a duplicate,
> so the resolved event must carry a different `externalId` than the firing one (an event id, not the monitor id).
> It closes the incident only when its `fingerprint` equals the firing alert's, so when you map `status`, also map
> `fingerprint` to an id of the problem that both events share. `config check` refuses a `status` mapping without a
> `fingerprint`.

### Example 1: minimal

Body (the whole body is one alert, always firing):

```json
{ "id": "evt-8841", "text": "Nightly export has not finished", "app": "reports" }
```

```yaml
connectors:
  - id: monitor
    type: webhook
    ingest:
      auth: { type: bearer, token: "${MONITOR_WEBHOOK_TOKEN}" }
      mapping:
        externalId: id
        title: text
        service: app
```

This gives severity `sev3`, status `firing`, `startedAt` equal to the receive time and signal `other`.

### Example 2: a batch with `alerts: alerts`

Body:

```json
{
  "batch_id": "batch-77",
  "alerts": [
    { "id": "b-1", "name": "disk usage", "host": "db-1", "app": "orders", "sev": "critical", "status": "firing", "at": 1791106890000 },
    { "id": "b-3", "name": "error rate", "host": "api-2", "app": "checkout", "sev": "notice", "status": "Resolved", "at": "2026-10-04T09:45:00Z" }
  ]
}
```

```yaml
connectors:
  - id: batcher
    type: webhook
    ingest:
      auth: { type: basic, username: batcher, password: "${BATCHER_WEBHOOK_PASSWORD}" }
      maxAlertsPerRequest: 50
      mapping:
        alerts: alerts
        externalId: id
        fingerprint: name          # required with status: a field both the firing and the resolved event share
        service: app
        title: { template: "{name} on {host}" }
        severity:
          path: sev
          map: { critical: sev1, warning: sev2 }
          default: sev3            # "notice" and anything unlisted
        status: { path: status }   # Resolved/resolved/OK/closed count as resolved
        startedAt: at              # epoch ms, epoch s or ISO
```

Paths start at each element, not at the envelope, so a field outside `alerts` (like `batch_id`) cannot be mapped.

### Example 3: signed with HMAC

```yaml
connectors:
  - id: signed
    type: webhook
    ingest:
      auth:
        type: hmac
        header: x-signature
        secret: "${SIGNED_WEBHOOK_SECRET}"
        prefix: "sha256="          # the sender writes sha256=<hex digest>
        # algorithm: sha256 | sha1   (default sha256)
        # encoding: hex | base64     (default hex)
      mapping:
        externalId: event_id
        fingerprint: monitor
        service: service
        title: message
        severity: { path: level, map: { high: sev1, medium: sev2 } }
        status: { path: state }
        startedAt: fired_at
        url: details_url
        attributes: { region: region, team: tags.team }
```

The sender signs the exact bytes it posts. With `openssl`:

```sh
SIG=$(openssl dgst -sha256 -hmac "$SIGNED_WEBHOOK_SECRET" -hex < payload.json | awk '{print $NF}')
curl -sS -X POST "http://127.0.0.1:3000/ingest/signed" \
  -H "Content-Type: application/json" \
  -H "X-Signature: sha256=$SIG" \
  --data-binary @payload.json
```

With Node:

```js
import { createHmac } from "node:crypto";
const body = JSON.stringify(payload);            // sign and send this exact string
const signature = "sha256=" + createHmac("sha256", process.env.SIGNED_WEBHOOK_SECRET).update(body).digest("hex");
await fetch("http://127.0.0.1:3000/ingest/signed", {
  method: "POST",
  headers: { "content-type": "application/json", "x-signature": signature },
  body,
});
```

Use `--data-binary` (not `-d`, which can alter newlines) with curl, and never re-serialize the JSON after signing: one
changed space makes the signature fail with 401.

Other vendors' webhooks could in principle be mapped the same way, but their field names, signature headers and
retry behavior must be checked in that vendor's own documentation: none are verified here.

## 3. Check the configuration

```sh
npm run cli -- config check                  # uses COPILOT_CONFIG
npm run cli -- config check --file copilot.yaml
```

It validates the file offline (no network) and reports a problem per path, never a secret value. A bad mapping path
(for example `externalId: "a..b"` or a `__proto__` segment) or a missing environment variable is reported here.

## 4. Send a test with curl

`tests/fixtures/connectors/webhook/single.json` matches the mapping of example 3. Switch that entry to
`auth: { type: bearer, token: "${SIGNED_WEBHOOK_TOKEN}" }` (or keep `hmac` and sign as shown above), then:

```sh
curl -sS -X POST "http://127.0.0.1:3000/ingest/signed" \
  -H "Authorization: Bearer $SIGNED_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @tests/fixtures/connectors/webhook/single.json
# 202 {"accepted":1,"duplicates":0,"ignored":null,"alertIds":["ALR-0001"],"requestId":"..."}

curl -sS "http://127.0.0.1:3000/ingest/alerts?limit=5" -H "Authorization: Bearer $API_TOKEN"
```

For `path_token`, post to `/ingest/<id>/<token>` with no auth header. Sending the same body again answers
`duplicates: 1`. A wrong or missing credential is 401 `invalid_webhook_credentials` and nothing is recorded. Sample
payloads are in `tests/fixtures/connectors/webhook/` (see its README).

## Unverified

- Exact response bodies shown above follow `docs/http-api.md`; check them against a running copilot.
- Any vendor's webhook format, signature header, field names and retry behavior: none was checked while writing this
  guide. Read the vendor's documentation before mapping its payload.
