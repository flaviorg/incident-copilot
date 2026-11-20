# Prometheus Alertmanager

Type `alertmanager`, the reference connector of 0.4. It **receives** alerts from an Alertmanager
[`webhook_config`](https://prometheus.io/docs/alerting/latest/configuration/#webhook_config) receiver and opens (or
deduplicates into) a live incident. It has no query capability: the copilot never writes PromQL in 0.4. Add a data
source connector (New Relic, Sentry, Bugsnag or MCP) for the investigation tools.

Every live incident runs in **shadow mode**: the team investigates and plans, the gate classifies each step by the
catalog, and nothing executes.

## 1. Choose a token and expose the copilot

1. Generate a webhook token of at least 16 characters and put it in the copilot's environment:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"
   export ALERTMANAGER_WEBHOOK_TOKEN=<the value>
   ```

2. Alertmanager must reach the copilot. When it is not on the same host:
   - set `HOST=0.0.0.0` (or the interface address) and `API_TOKEN` (required off loopback; `/ingest/*` does not use it,
     every other route does);
   - add the name Alertmanager uses in the URL to `ALLOWED_HOSTS` (for example `copilot.internal:3000`), or the
     request gets 421 from the host guard;
   - behind a reverse proxy, set `ingest.trustProxy` in `copilot.yaml` so the source IP is the client's. Use the number
     of proxies in front of the copilot (`trustProxy: 1` for one) or the list of their addresses or CIDR ranges
     (`trustProxy: ["10.0.0.0/8"]`). Plain `true` is refused: it trusts every hop, and a client can then put any
     address in front of its own in `X-Forwarded-For`, which defeats `allowedIps`. The count is right when your proxy
     appends to the header; with a count of 1 the address the proxy saw is used.

## 2. Configure the copilot

`copilot.yaml` (path in `COPILOT_CONFIG`):

```yaml
version: 1
mode: shadow
services:
  - name: checkout-api              # the canonical name used by the copilot
    aliases:
      prom: [checkout]              # the value of the "service" label in Prometheus
connectors:
  - id: prom                        # the URL path: /ingest/prom
    type: alertmanager
    ingest:
      auth: { type: bearer, token: "${ALERTMANAGER_WEBHOOK_TOKEN}" }
    # Optional, with these defaults:
    # serviceLabel: service           # label that names the service
    # fallbackServiceLabels: [job]    # tried in order when serviceLabel is missing
    # titleAnnotation: summary        # annotation used as the incident title (else the alertname label)
    # severityLabel: severity
    # severityMap: { critical: sev1, error: sev2, warning: sev2, info: sev3 }  # case-insensitive; anything else is sev3
```

Basic authentication works too: `auth: { type: basic, username: alertmanager, password: "${ALERTMANAGER_WEBHOOK_PASSWORD}" }`.
Secrets are accepted only as a whole `${VAR}` reference; check the file with `npm run cli -- config check`.

## 3. Configure Alertmanager

`alertmanager.yml`:

```yaml
route:
  receiver: default
  routes:
    - receiver: incident-copilot
      matchers:
        - severity =~ "critical|error"
      continue: true                # keep notifying your usual receivers

receivers:
  - name: default
  - name: incident-copilot
    webhook_configs:
      - url: https://copilot.example.com/ingest/prom
        send_resolved: true         # the default; resolved alerts close the live incident
        max_alerts: 20
        http_config:
          authorization:
            type: Bearer
            credentials_file: /etc/alertmanager/secrets/copilot-token
```

Reload Alertmanager (`curl -X POST http://localhost:9093/-/reload` or `SIGHUP`).

## 4. Test with curl

```sh
curl -sS -X POST "http://127.0.0.1:3000/ingest/prom" \
  -H "Authorization: Bearer $ALERTMANAGER_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @tests/fixtures/connectors/alertmanager/firing.json
# 202 {"accepted":2,"duplicates":0,"ignored":null,"alertIds":["ALR-0001","ALR-0002"],"requestId":"..."}

curl -sS "http://127.0.0.1:3000/ingest/alerts?limit=5" -H "Authorization: Bearer $API_TOKEN"
```

Posting the same file again answers `duplicates: 2`. Without the token, or with a wrong one, the answer is 401
`invalid_webhook_credentials` and nothing is recorded.

## How a payload is mapped

| NormalizedAlert | From |
|---|---|
| `externalId` | `<fingerprint>:<startsAt>:<status>` (stable across Alertmanager retries) |
| `fingerprint` | the alert `fingerprint`, else a hash of its sorted labels |
| `service` | label `serviceLabel`, else the first `fallbackServiceLabels` present; then mapped through `services[].aliases.<id>` |
| `title` | annotation `titleAnnotation`, else label `alertname`, else "Alertmanager alert" |
| `severity` | label `severityLabel` through `severityMap` |
| `status` | the alert `status` (`firing` or `resolved`; anything else is skipped) |
| `startedAt` | `startsAt` for a firing alert, `endsAt` for a resolved one; the receive time when missing or the Go zero time |
| `url` | `generatorURL` when it is http(s) |
| `attributes` | `alertname`, `receiver`, `groupKey`, `truncatedAlerts` (when above 0) and up to 15 `label.<name>` entries |

All text is sanitized (control characters removed, `<<<` and `>>>` neutralized, clipped) and reaches the model only as
alert data. An empty `alerts` array is acknowledged as ignored; a body without `alerts` is 400 `invalid_payload`.

## Facts and sources

From https://prometheus.io/docs/alerting/latest/configuration/ (checked for 0.4.0):

- `webhook_config` POSTs a JSON body; `send_resolved` defaults to `true`; `max_alerts` truncates the alert list and the
  number left out is in `truncatedAlerts`.
- `http_config.authorization` sends `Authorization: <type> <credentials>`, with `type` defaulting to `Bearer`;
  `basic_auth` is the alternative. Alertmanager does not sign payloads, so HMAC is not offered for this type.
- The default payload `version` is `"4"`, with the top-level keys `version`, `groupKey`, `truncatedAlerts`, `status`,
  `receiver`, `groupLabels`, `commonLabels`, `commonAnnotations`, `externalURL`, `notification_reason` and `alerts`; each
  alert has `status`, `labels`, `annotations`, `startsAt`, `endsAt`, `generatorURL` and `fingerprint`.

## Unverified

Handled defensively, not relied upon:

- The exact timestamp format of `startsAt` and `endsAt`: the parser accepts RFC 3339 with any fraction digits
  (nanoseconds included) and offsets, and treats the Go zero time `0001-01-01T00:00:00Z` as missing.
- The set of `notification_reason` values: kept out of the mapping.
- Alertmanager's retry behavior on a non-2xx answer: the copilot answers 202 fast and is idempotent on `externalId`,
  so a retry is counted as a duplicate.
