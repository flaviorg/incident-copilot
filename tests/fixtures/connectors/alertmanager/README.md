# Alertmanager payload fixtures

Representative payloads built by hand from the documented `webhook_config` format, payload version `4`
(https://prometheus.io/docs/alerting/latest/configuration/#webhook_config). They are not recordings of a real
Alertmanager; names, hosts and fingerprints are our own.

| File | What it shows |
|---|---|
| `firing.json` | A group for service `checkout` with one firing alert (nanosecond `startsAt`, Go zero `endsAt`) and one resolved alert of another instance |
| `resolved.json` | The firing alert of `firing.json` resolved: same `fingerprint` and `startsAt`, `endsAt` set |

Top-level keys used: `version`, `groupKey`, `truncatedAlerts`, `status`, `receiver`, `groupLabels`, `commonLabels`,
`commonAnnotations`, `externalURL`, `notification_reason` and `alerts[]` (`status`, `labels`, `annotations`, `startsAt`,
`endsAt`, `generatorURL`, `fingerprint`). The exact `notification_reason` values and the timestamp precision are
not confirmed by the documentation, so the connector does not depend on them.
