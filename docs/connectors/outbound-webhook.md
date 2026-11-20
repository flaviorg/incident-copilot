# Outbound webhook

Type `outbound-webhook`, a notifier. It `POST`s each notification as JSON to a URL you choose, so any system that can
receive an HTTP request (a pager, a chat bridge, a ticketing script, a log pipeline) can follow the incidents. It is the
copilot's own format, so there is no provider to read about: this page is the contract.

It only sends. A failed send is logged and never changes the incident. Live incidents run in shadow mode, and every
recommendation in a message is something the copilot would do, not something it did.

## 1. Configure the copilot

```sh
export INCIDENT_HOOK_SIGNING_SECRET=<at least 16 characters, for example from: openssl rand -hex 32>
```

`copilot.yaml` (path in `COPILOT_CONFIG`):

```yaml
version: 1
mode: shadow
publicUrl: https://copilot.example.com
notifiers:
  - id: ops-hook
    type: outbound-webhook
    url: https://hooks.example.com/incident-copilot
    signingSecret: "${INCIDENT_HOOK_SIGNING_SECRET}"
    # bearerToken: "${INCIDENT_HOOK_BEARER}"
    events: [analysis_ready, incident_resolved]      # default: all four
```

| Key | Meaning |
|---|---|
| `url` | Required unless `urlIsSecret` is true. `https`, or `http` for `localhost`, `127.0.0.1` and `[::1]` only; no credentials in the URL. `${VAR}` references are interpolated. |
| `urlIsSecret` | Optional, default `false`. Set it to `true` when the URL itself is a credential (a token in the path). Then give the URL as `secretUrl` instead of `url`. |
| `secretUrl` | `${VAR}` naming a variable that holds the URL (same URL rules as `url`). The value is redacted from logs and errors. Only with `urlIsSecret: true`. |
| `signingSecret` | Optional. A whole `${VAR}` of at least 16 characters. Turns on the signature headers (section 3). |
| `bearerToken` | Optional. A whole `${VAR}` of at least 16 characters, sent as `Authorization: Bearer <token>`. |
| `events` | Optional. Any of `incident_opened`, `analysis_ready`, `run_failed`, `incident_resolved`. Defaults to all four. |

Unknown keys are refused. Secrets are accepted only as a whole `${VAR}` reference. Check the file with
`npm run cli -- config check`; a problem is reported by path and rule and never shows a value. Prefer a `signingSecret`
to a Bearer token when the receiver can verify it: the signature also proves the body was not altered.

## 2. Payload

`Content-Type: application/json`. The body is the notification message with `schemaVersion` first:

```json
{
  "schemaVersion": 1,
  "kind": "analysis_ready",
  "incidentId": "INC-0001",
  "title": "High error rate in checkout",
  "service": "checkout-api",
  "severity": "sev2",
  "status": "advised",
  "source": { "connectorId": "prom", "type": "alertmanager", "url": "https://prometheus.example.com/graph?g0.expr=up" },
  "diagnosis": { "category": "bad_deploy", "confidence": "high", "hypothesis": "The v2.4.0 deploy introduced a TypeError in PriceFormatter" },
  "recommendations": [
    { "order": 1, "actionType": "rollback_deployment", "target": "deployment/checkout-api", "tier": 3, "status": "recommended" },
    { "order": 3, "actionType": "run_arbitrary_command", "target": "host/checkout-api", "tier": 4, "status": "blocked_forbidden" }
  ],
  "links": { "incident": "https://copilot.example.com/incidents/INC-0001" },
  "sentAt": "2026-10-04T10:05:00.000Z"
}
```

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | `1` | Version of this payload. Fields may be added within a version; a breaking change bumps it. Ignore unknown fields. |
| `kind` | string | `incident_opened`, `analysis_ready`, `run_failed` or `incident_resolved`. |
| `incidentId` | string | The copilot's incident id, for example `INC-0001`. |
| `title` | string | Incident title. Comes from the alert: treat it as untrusted text. |
| `service` | string or null | Canonical service name, or `null` when the alert named none. |
| `severity` | string | `sev1`, `sev2` or `sev3`. |
| `status` | string | `open`, `investigating`, `awaiting_approval`, `mitigating`, `resolved`, `escalated` or `advised`. Live incidents in shadow mode end as `advised`. |
| `source` | object | Where the incident came from: `connectorId` (the id in `copilot.yaml`), `type` (for example `alertmanager`) and `url` (a link to the alert, or `null`). |
| `diagnosis` | object or null | `category` (for example `bad_deploy`), `confidence` (`low`, `medium` or `high`) and `hypothesis` (model-written text: untrusted). `null` before the analysis. |
| `recommendations` | array | The plan's recommended and blocked steps in `order`. Each has `order`, `actionType`, `target`, `tier` and `status`. Empty before the analysis. |
| `recommendations[].tier` | `1` to `4` | Taken from the action catalog, never from the model. 3 needs human approval; 4 is forbidden by construction. |
| `recommendations[].status` | string | `recommended`, `blocked_forbidden` or `blocked_unknown` (or another `blocked_*`). In shadow mode nothing is executed. |
| `links.incident` | string or null | URL of the incident in the copilot, built from `publicUrl`; `null` when `publicUrl` is not set. |
| `sentAt` | string | ISO 8601 UTC time the message was built. |

The message is redacted for the secrets of the copilot's configuration before it is sent.

## 3. Headers

| Header | Sent | Value |
|---|---|---|
| `Content-Type` | always | `application/json` |
| `User-Agent` | always | `incident-copilot/<version>` |
| `Authorization` | with `bearerToken` | `Bearer <token>` |
| `X-Incident-Copilot-Timestamp` | with `signingSecret` | Unix time in seconds when this attempt was made |
| `X-Incident-Copilot-Signature` | with `signingSecret` | `sha256=` followed by the lowercase hex HMAC-SHA256 of `<timestamp>.<raw body>` keyed with the signing secret |

The retry is a new attempt: same body, new timestamp, new signature.

## 4. Verify the signature

Compute the HMAC over the exact bytes you received, not over a re-serialized JSON object, compare in constant time, and
reject old timestamps so a captured request cannot be replayed. Reject anything older than 5 minutes.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 300;

/** rawBody: the request body exactly as received (string or Buffer); headers: lowercase header names. */
export function verifyIncidentCopilot(rawBody, headers, signingSecret, nowMs = Date.now()) {
  const timestamp = headers["x-incident-copilot-timestamp"];
  const signature = headers["x-incident-copilot-signature"];
  if (typeof timestamp !== "string" || !/^\d{1,12}$/.test(timestamp) || typeof signature !== "string") return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const expected = "sha256=" + createHmac("sha256", signingSecret).update(`${timestamp}.`).update(body).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Read the raw body before any JSON parser touches it (for Express, `express.raw({ type: "application/json" })`; for
Fastify, a content-type parser with `parseAs: "buffer"`). Use `schemaVersion` to pick how you parse the body, answer
with a `2xx` as soon as you have stored the message, and make your handler idempotent: a retry can deliver the same
message twice.

## 5. Delivery and retries

| Your answer | Result |
|---|---|
| `2xx` | Delivered. The body is ignored. |
| `429` or `5xx` | Retried once, after `Retry-After` (seconds or an HTTP date, at most 10 seconds waited; 1 second when absent). |
| Timeout (5 seconds per attempt) or a network failure | Retried once, after 1 second. |
| Any other status (`3xx`, `4xx`) | Not retried. Redirects are not followed. |

After the retry the failure is logged with a fixed reason (`http 410`, `unavailable`, `timed out`, ...) and dropped:
nothing is queued, and the incident is not affected. The log never contains the URL, the headers or your answer.

## Facts and sources

This is the copilot's own interface; no provider documentation applies. The signature scheme (`<timestamp>.<body>`
under HMAC-SHA256, constant-time comparison, a timestamp tolerance) is the common webhook-signing pattern and was
designed here, not copied from a vendor. The behavior above is what `tests/unit/notifiers-outbound-webhook.unit.test.ts`
asserts, including an independent `node:crypto` computation of the signature.

## Unverified

- How your receiver's framework exposes the raw body: the `express.raw` and Fastify hints above were not run against
  this notifier.
- Whether an intermediary (a gateway, a WAF) rewrites the body or the headers before your handler: if it does, the
  signature will not verify, and the fix is on the receiver's side.
