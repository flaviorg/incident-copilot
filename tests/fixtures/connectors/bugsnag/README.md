# Bugsnag fixtures

Strict JSON built by hand from the documented fields. They are not recordings of a real Bugsnag account: names, ids,
hosts and numbers are illustrative.

Sources:

- Webhook payloads: https://docs.bugsnag.com/product/integrations/data-forwarding/webhook/ (top-level `account`,
  `project`, `trigger`, optional `error` and `release`; `trigger.type` and `trigger.stateChange` values). The official
  example is JavaScript-like rather than strict JSON, and its `lineNumber` values are strings; the fixtures follow that.
- Data Access API responses: https://developer.smartbear.com/bugsnag/docs/data-access-base-server-url and the pages on
  authentication, versioning and pagination. The endpoint paths and the snake_case response field names are inferred
  from secondary sources and are **not confirmed** (see `docs/connectors/bugsnag.md`).

| File | What it shows |
|---|---|
| `exception.json` | `exception` trigger with a full `error` (severity `error`, `unhandled`, one exception with a stack trace) |
| `first-exception.json` | `firstException` trigger, severity `warning` |
| `project-spiking.json` | `projectSpiking`: no `error` object |
| `error-fixed.json` | `errorStateManualChange` with `stateChange: fixed` (resolves the `exception.json` error) |
| `error-snoozed.json` | `errorStateManualChange` with `stateChange: snoozed` (not an alert) |
| `comment.json` | `comment` trigger (always ignored) |
| `release.json` | `release` trigger (always ignored) |
| `api-errors.json` | Data Access API: list of errors on a project |
| `api-releases.json` | Data Access API: list of releases on a project |
