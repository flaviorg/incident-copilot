# Generic webhook payload fixtures

Example payloads written by hand for the generic `webhook` connector. They are our own shapes, not recordings of
any vendor's webhook; field names, hosts and ids are invented. The mapping in `tests/unit/connectors-webhook*.unit.test.ts`
says where each field lives.

| File | What it shows |
|---|---|
| `single.json` | One alert as the whole body: flat fields, an ISO timestamp, a nested `tags` object |
| `resolved.json` | The same monitor recovering: state `OK` (a resolved value), `fired_at` in epoch seconds |
| `batch.json` | `alerts[]` with three elements: the second has no id and is skipped; numeric timestamps (ms) and ISO; a mixed-case `Resolved` status |
| `nested.json` | Alerts reached only through numeric index paths (`data.events.0.ref.id`), a numeric value (`latency_ms`) and a boolean (`open`) |
