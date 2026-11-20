# New Relic payload fixtures

These files were built by hand from the documented webhook template and variables
(https://docs.newrelic.com/docs/alerts/get-notified/custom-variables-incident-workflows) and from the NerdGraph NRQL
tutorial response shape (https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-nrql-tutorial/). They were
**not captured** from a real New Relic account; names, ids and timestamps are our own. Two shapes are guesses, listed
under "Unverified" in `docs/connectors/newrelic.md`: the rendered form of `{{json entitiesData}}` and the TIMESERIES
row shape.

| File | What it shows |
|---|---|
| `issue-activated.json` | Webhook body rendered by the documented template for an `ACTIVATED` issue (epoch-millisecond `createdAt`) |
| `issue-closed.json` | The same issue with `state: CLOSED` and `closedAt` set |
| `issue-unknown-state.json` | A `state` the connector does not act on; it must be ignored |
| `nerdgraph-timeseries.json` | `results` of a TIMESERIES query: `beginTimeSeconds`, `endTimeSeconds` and one value (one row has a null value) |
| `nerdgraph-timeseries-nested.json` | A TIMESERIES row whose value is nested (`percentile.duration` holding `{"99": ...}`) |
| `nerdgraph-facet-errors.json` | `results` of a FACET query: `facet` as an array, and `error.class` / `error.message` keys |
| `nerdgraph-logs.json` | Rows of `timestamp`, `level`, `message` |
| `nerdgraph-deploys.json` | Rows of `timestamp`, `version`, `user`, `description` |
| `nerdgraph-graphql-error.json` | A response with an `errors` array |
