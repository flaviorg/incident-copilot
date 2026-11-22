# Sentry payload fixtures

Built by hand from the field tables and the abridged examples in the Sentry documentation
(https://docs.sentry.io/organization/integrations/integration-platform/webhooks/ and its `issue-alerts`,
`metric-alerts` and `issues` pages, plus the REST reference under https://docs.sentry.io/api/). They are **not**
captured from a real Sentry; organization, project, ids, names and timestamps are our own.

| File | What it shows |
|---|---|
| `event-alert.json` | `Sentry-Hook-Resource: event_alert`, action `triggered`, with `data.event` and `data.triggered_rule` |
| `metric-alert-critical.json` | `metric_alert`, action `critical`; `projects` as slug strings |
| `metric-alert-resolved.json` | `metric_alert`, action `resolved`, `date_closed` set; `projects` as objects |
| `issue-created.json` | `issue`, action `created`, same issue id as `event-alert.json` (they dedupe together) |
| `issue-resolved.json` | `issue`, action `resolved` |
| `issue-assigned.json` | `issue`, action `assigned` (ignored by the connector) |
| `installation.json` | `installation`, action `created` (ignored by the connector) |
| `api-project-issues.json` | `GET /api/0/projects/{org}/{project}/issues/` response; the last two items are hostile or malformed on purpose |
| `api-project.json` | `GET /api/0/projects/{org}/{project}/` response (numeric `id`) |
| `api-releases.json` | `GET /api/0/organizations/{org}/releases/` response, with releases of two projects |
| `api-issue-detail.json` | `GET /api/0/organizations/{org}/issues/{issue_id}/` response (`firstSeen`, `project.slug`), for `errorEvent` |
| `api-event-latest.json` | `GET /api/0/organizations/{org}/issues/{issue_id}/events/latest/` response: a `release` tag, an `exception` entry with two values (the last one is raised; one frame has only `abs_path`, one has line 0, one value carries a delimiter on purpose) and `vars`, `context_line`, `pre_context`, `post_context`, `user`, `contexts`, `breadcrumbs` and `request` that the connector must never read |
| `api-release-detail.json` | `GET /api/0/organizations/{org}/releases/{version}/` response with `lastCommit.id` and `lastCommit.repository.name`, for `releaseCommit` |

The webhook files carry no signature: the tests compute `Sentry-Hook-Signature` over the exact bytes of each file and
set `Sentry-Hook-Resource` from the payload shape. Which `event_alert` field carries the project (`data.event.project`
here), the type of `metric_alert.projects` entries (both forms are covered), the issue list endpoint and the project
detail endpoint are not confirmed by the documentation; see `docs/connectors/sentry.md`, section Unverified.

The three code-fixer files (spec 009, decision 5) follow the REST reference pages "Retrieve an Issue", "Retrieve an
Issue Event" (`latest`) and "Retrieve an Organization's Releases" (release detail) under https://docs.sentry.io/api/,
and the event payload shape (`entries`, `tags` as `{ key, value }`, `stacktrace.frames` oldest first) from the event
payload documentation at https://develop.sentry.dev/sdk/data-model/event-payloads/. **Unverified:** the organization
scoped issue and latest-event paths, the `entries[type=exception].data.values` shape of that endpoint's response, the
order of chained exception values (the raised one last), the `release` tag, and the `lastCommit` field with its
`repository.name` on the release detail response. The connector reads them defensively. Secret-shaped values are
never stored here: the tests inject them at run time.
