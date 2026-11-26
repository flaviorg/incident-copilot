# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.5.0] - 2026-11-22

Code fixer (spec [`009-code-fixer`](specs/009-code-fixer/spec.md), AC-60 to AC-85). When a live incident's diagnosis and Sentry's own data point at a small bug in an allowlisted repository, the copilot writes a regression test that must fail, the smallest patch that makes it pass, verifies both in a sandbox, has the diff reviewed, and attaches patch and evidence to the report. In `draft_pr` mode a human approval then opens a **draft** pull request on GitHub; nothing is ever merged. Without a `codeFix` block the copilot behaves exactly as in 0.4. Guide: [`docs/code-fixer.md`](docs/code-fixer.md).

### Added

- **Code-fix job** outside the incident graph: `CodeFixService` and `CodeFixQueue` (`src/app/`) start after a live incident is persisted as `advised`, with their own concurrency (`limits.maxConcurrent`), no run slot, no `runs` row and no blackboard write. A small LangGraph graph of its own (`src/graph/code-fix/`): `fix_eligibility`, `fix_locate`, `fix_workspace`, `fix_baseline`, `fix_author_test`, `fix_guard_test`, `fix_repro`, `fix_author_patch`, `fix_guard_patch`, `fix_verify`, `fix_review`, `fix_finalize` and `fix_give_up`, with pure routes and budgets checked before every LLM node.
- **Deterministic eligibility and location** (`src/domain/code-fix/`): Sentry issue alerts only, `bad_deploy` with medium or high confidence, one allowlisted repository per service, an exception type in `fixableExceptionTypes`, an error group new in the failing release, the innermost in-app frame inside `sourceGlobs` and outside the denied paths, and a 40-hex commit confirmed by GitHub. Every failure is a typed `skipped` reason with an audit row and no git or LLM call.
- **Sentry query members** `errorEvent` (the latest event's exception and stack frames) and `releaseCommit` (release version to commit SHA). They are not LLM tools.
- **`GitCliWorkspace`**: a hardened shallow fetch into a temporary directory (no shell; the host's git config, hooks, symlinks, fsmonitor, credential helpers, submodules and LFS disabled; https only; the token only through a temporary askpass script), removed when the attempt ends.
- **`ProcessSandboxRunner`**: `node --test` under the Node permission model (reads only in the work tree, the kit and `tmp/`, writes only in `tmp/`, no child process, worker, addon, WASI or inspector right), an allowlisted environment, a process-group timeout, capped and redacted output, our own NDJSON reporter cross-checked with the exit code, and network isolation through `unshare --user --map-root-user --net` (`codeFix.sandbox.network: isolated`) or an explicit, stamped `best_effort`. A startup self-test must prove every denial, or the fixer is disabled and eligible incidents are `skipped/sandbox_unavailable`.
- **Two authors and a veto-only reviewer**: prompts `fix-test.v1`, `fix-patch.v1` (which never sees the test) and `fix-review.v1` in a new `FIX_PROMPTS` list. Pure guards `checkTestFile`, `checkPatch` and `checkDiff` report every violation at once; `classifyReproduction` requires both runs to fail with the incident's error in the anchor file, within 10 lines of the anchor line.
- **Limits with fixed ceilings** (`src/domain/code-fix/limits.ts`): at most 3 files, 20 source lines, 50 total lines, 40 test lines and 2 edits, plus LLM call, token, time, output, daily and per-group caps. Config can only lower them.
- **GitHub code host** (`src/codehost/github/`): REST over the injected `fetch` with timeout, response cap and no redirects; a reader (commit, branch, compare, pull lookup, ref, commit object) and a writer that can only open a draft pull request. Owner and repository are checked against the allowlist before any request; errors are `CodeHostError` kinds with no body, header or token.
- **`CodeFixPublisher`**: after approval it verifies the stored patch and post-images against the approved hash, re-classifies the action as tier 3, requires a protected and unchanged base, builds one deterministic commit on `incident-copilot/fix-<attemptId>` and opens the pull request with `draft: true`; a retry reuses its own branch or pull request.
- **Catalog action `open_draft_pull_request`**: tier 3, not a mitigation, not reversible, reserved for the new `code_fixer` proposer. `ActionSpec` gains `proposers`, `TargetKind` gains `repository`, and `ClassificationContext` gains a required `proposer`; the planner or an MCP client proposing it gets tier 4 (`blocked_forbidden`, MCP refusal `action_reserved`), and the planner's prompt does not list it.
- **Modes**: `codeFix.mode: shadow` (default) ends a successful attempt at `patch_ready` with no GitHub write; `draft_pr` moves it to `awaiting_approval` with an approval bound to the patch hash (`approvalTtlHours`, default 72).
- **Surfaces**: `GET /incidents/:id/code-fix` (the latest attempt, redacted, without post-images), a "Code fix" section appended to the Markdown postmortem only when an attempt exists, code-fix approvals in `GET /approvals` and `POST /approvals/:id/decision` (409 `code_fix_not_awaiting_approval`), and the opt-in notification kinds `code_fix_ready` and `code_fix_pr_opened`.
- **Audit events** `code_fix_skipped`, `code_fix_started`, `code_fix_gave_up`, `code_fix_patch_ready`, `code_fix_pr_opened` and `code_fix_publish_failed`; approvals reuse `approval_*` with `details.subject: "code_fix"`. Agent id `code_fixer`.
- **`copilot.yaml` `codeFix` section**, strict, with `{ path, rule }` cross-checks (service, connector of type `sentry`, unique repository, glob allowlist, a token for `draft_pr`). `assertLiveSafe` refuses `draft_pr` without `APPROVAL_TOKEN` or a token. `copilot.example.yaml` has a shadow-mode block with `${GITHUB_FIX_TOKEN}`, and `.env.example` lists `GITHUB_FIX_TOKEN`.
- **Docs**: `docs/code-fixer.md` (flow, eligibility, reason tables, limits, denied paths, isolation, token setup, modes, approvals with `curl`, facts and unverified items), a "Code fixer" section in `docs/connectors/sentry.md`, the new trust boundaries in `docs/threat-model.md` and `docs/architecture.md`, Node 24.21 permission-model and test-runner checks in `docs/api-notes.md`, README "Code fixes", AGENTS.md "How the code fixer works".
- **Tests**: unit tests for every pure rule, the graph, the service, the store, approvals and the publisher; end-to-end tests with a real `node --test` child, real git over a local bare repository and a fake GitHub (`tests/e2e/code-fix*.e2e.test.ts`), on the `tiny-cart` fixture repository.

### Changed

- Schema version 5: tables `code_fix_attempts` (with a partial unique index on `(repo, error_group_id)` while the key is held) and `code_fix_approvals`. `trace_events` joins the enum-checked tables, so a v4 database rebuilds its CHECK in place, keeping every row, `seq`, the audit hash chain and the append-only triggers.
- `ApprovalSchema` gains the optional `subject` and `patchSha256`, with no defaults, so action approvals are byte-identical. `ApprovalService.decide` branches on the table right after the lookup, before any expiry handling.
- The notifier `events` default is now the fixed list of the four 0.4 kinds, and its maximum grows to 6.
- `npm run fixtures:rehash` hashes `[...ALL_PROMPTS, ...FIX_PROMPTS]` but writes a `fix-*` hash only into a fixture that has a turn of that prompt.
- The runtime image installs `git`, `util-linux` and `ca-certificates` and sets `TMPDIR=/data/code-fix`, a scratch directory owned by `node`.
- Version bumped to 0.5.0 in both packages.

### Dependencies

- No new npm dependency. The runtime image gains the system packages `git` (workspace) and `util-linux` (`unshare`), plus `ca-certificates` so git can verify https.

### Security

- Model-written code runs only in the sandbox above; the copilot's source, `copilot.yaml`, `.env` and database are outside every read grant, and `GITHUB_FIX_TOKEN`, `OPENROUTER_API_KEY`, `APPROVAL_TOKEN` and `API_TOKEN` are never in the child's environment.
- The fixer graph never receives a GitHub writer; only the publisher has one, only for an approved attempt, and only in `draft_pr` mode.
- Stack traces, exception messages, repository files and test output are untrusted: sanitized, clipped, fenced for the model, scanned for injection markers in model output, and never used to choose a repository, path, commit, command, tier, approval or publication.
- Every text the fixer sends out goes through `redactSecrets`; a patch that redaction would change gives up with `patch_contains_secret`, and the pull request body never carries test output text.

## [0.4.0] - 2026-11-20

Connectors and live incidents (spec [`008-connectors`](specs/008-connectors/spec.md), AC-42 to AC-59). The copilot now plugs into a team's own observability and error stack: providers send alerts by webhook, the team investigates with read-only provider data, and the outcome goes to chat. Every live incident runs in **shadow mode**: nothing executes. Scenario mode (demo, goldens, recordings, War Room) is unchanged.

### Added

- **Connector port** (`src/connectors/types.ts`) with `ingest` (verify and parse a webhook into `NormalizedAlert`s) and `query` (read-only errors, metrics, logs, deploys and external tools) capabilities, a registry (`CONNECTOR_DEFINITIONS`), a shared kit (HTTP over an injected `fetch` with timeout, response cap and no redirects; webhook auth schemes; config helpers; `ConnectorError` kinds) and a conformance test kit.
- **Connectors:** `alertmanager` (webhook, Bearer or Basic), `newrelic` (Workflows webhook; NerdGraph NRQL from config templates), `sentry` (HMAC-SHA256-signed Integration Platform webhooks; issues and releases over REST), `bugsnag` (Data Forwarding webhook with a secret URL token; Data Access API errors and releases), `webhook` (any JSON with a field mapping) and `mcp` (allowlisted read-only tools of any MCP server over HTTP or stdio).
- **Notifiers:** `slack` (incoming webhook, escaped text) and `outbound-webhook` (JSON, optional Bearer and HMAC signature with a timestamp), for `incident_opened`, `analysis_ready`, `run_failed` and `incident_resolved`. A notifier failure is logged and never changes the incident.
- **Live ingest:** `POST /ingest/:connectorId` and `/ingest/:connectorId/:token` answer 202 after verify, parse, record and enqueue; an in-process `AlertQueue` runs the graph under `MAX_CONCURRENT_RUNS`, in arrival order per fingerprint, recovers queued alerts on start and drains on shutdown. Idempotency on `(connectorId, externalId)`, dedupe into an open live incident by fingerprint within `ingest.dedupeWindowMin`, resolution by a resolved alert.
- **Shadow mode:** the gate classifies every step with the catalog, records accepted tier 2 and 3 steps as `recommended`, blocks tier 4 and unknown types as before, and hands off to the reporter, which writes an `advisory` report from the template. Real executors are on the roadmap.
- **Live tools:** `query_errors` and `query_external` (tier 1), and live versions of `query_metrics`, `query_logs` and `list_deploys`, each offered only when a configured connector can answer it; results are sanitized untrusted observations.
- **`copilot.yaml`** (path in `COPILOT_CONFIG`): YAML or JSON, zod-validated, `${VAR}` interpolation, secrets only as whole `${VAR}` references, `mode: shadow` only, services with per-connector aliases, ingest limits. `copilot.example.yaml` covers every connector and notifier type.
- **CLI `config check [--file <path>]`:** validates the file and prints connectors, capabilities, ingest paths and notifiers; problems as `{ path, rule }`, never a value.
- **Routes:** `POST /ingest/*`, `GET /connectors`, `GET /ingest/alerts`.
- **Statuses and events:** incident status `advised`, action status `recommended`, post-mortem status `advisory`, audit events `alert_ingested`, `alert_resolved` and `action_recommended`; alert ids `ALR-####`.
- **Packaging:** `Dockerfile` (API only, non-root, `/data` volume, health check) and `docker-compose.yml` (one service, port published on loopback).
- **Docs:** a setup guide per type in `docs/connectors/`, each with "Facts and sources" and "Unverified" sections; `docs/connectors-architecture.md`; README "Connect your stack"; AGENTS.md "How to add a connector" and "How to add a notifier".

### Changed

- Tools are async: `Tool.run`, `ToolRegistry.run`, `names` and `describeForPrompt` return promises and take the incident context. The scenario tool description is byte-identical (checked against a frozen copy).
- Nodes (telemetry, auditor, reporter, executor, verifier) receive an `IncidentContextResolver` instead of the scenario repository; the executor and verifier refuse a live context.
- `RunSlots` is shared by `POST /incidents` and the alert queue instead of a private counter in the route.
- Schema version 4: tables `ingested_alerts` and `live_incidents`; an in-place migration rebuilds `incidents`, `actions` and `audit_log` when their stored CHECK lacks a new enum value, keeping rows, `seq`, the hash chain and the append-only triggers.
- The 413 message no longer names a fixed size, since routes now have different body limits.
- Version bumped to 0.4.0 in both packages.

### Dependencies

- `yaml` 2.8.1 (exact): operators hand-edit `copilot.yaml` and need comments, which JSON lacks; Node 24 has no YAML parser; the package has no dependencies and ships its own types. It parses with the core schema and the default alias cap, and zod validates the result. API checked in `docs/api-notes.md`.

### Security

- Mandatory per-connector webhook authentication (HMAC on the raw bytes for Sentry and the generic webhook, URL token and IP allowlist for Bugsnag, Bearer, Basic or header otherwise), all comparisons constant-time, generic 401 with nothing recorded.
- Per-route body cap, per-connector token bucket (spent only after the credentials verify, so bad credentials cannot starve the real provider) and a bounded queue (413, 429 with `Retry-After`, 503 while the queue is full; one request is never split or refused for being larger than the room left).
- Inbound and queried text is sanitized and reaches the model only as alert data or untrusted observations; NRQL comes only from config templates with an allowlist for substituted values; MCP tools need an explicit allowlist and destructive or non-read-only tools are refused.
- Secrets resolved from `copilot.yaml` join the redaction list; request URLs are redacted before they are clipped in the access log and the 404 message, so a URL token never leaks, not even as a prefix.
- `npm start` refuses ingest connectors with the fake provider (an entry decides, not its type: a query-only entry is allowed).
- `query_external` is operator-controlled: an MCP tool takes the `arguments` template written in `copilot.yaml`, the model only fills `{service}` (scope-checked, alias-mapped) and `{window}`, and any other key is `unsafe_input` before the server is contacted. The server's own input schema is never shown to the model.
- The alert of a live incident reaches the telemetry, planner and supervisor prompts as external data: delimited as an untrusted observation, with a notice that its title, rule and service are never instructions. Scenario prompts are byte-identical.
- `ingest.trustProxy` is `false`, a hop count or a list of proxy addresses or CIDR ranges; plain `true` is refused because it lets a client choose its address in `X-Forwarded-For` and defeats `allowedIps`.
- The server accepts path parameters of up to 256 characters (a 128-character webhook token no longer answers 414), and a longer one gets a redacted error in our format.
- A webhook mapping with `status` requires `fingerprint`, so a resolved event can find its incident.

### Fixed

- A live run that fails (an exception, `llm_unavailable` or `timeout`) closes its `live_incidents` row, so the next firing alert of that fingerprint opens a fresh incident instead of being deduplicated into a dead one.
- Notifications no longer sit in the run's path: `incident_opened` is sent while the investigation runs and the others after the run slot is released, so a slow notifier delays neither the diagnosis nor the next run.

## [0.3.0] - 2026-11-20

The 18 low-severity findings of the November 2026 review, all fixed. Details and tests per finding in [`docs/code-review-2026-11.md`](docs/code-review-2026-11.md).

### Added

- `POST /incidents/:id/resume` retries a resume whose run failed after every approval was decided; before, the incident stayed `mitigating` forever.
- `ALLOWED_HOSTS` and `MAX_CONCURRENT_RUNS` (default 2) settings.
- `API_TOKEN`: with it set, every HTTP route except `GET /health` needs `Authorization: Bearer <API_TOKEN>` (401 `invalid_api_token`). It is required when `HOST` is not a loopback address, so `npm start` refuses to expose the API without one, and it must differ from `APPROVAL_TOKEN`.
- Auditor rule in code `unique_orders`: a plan with a repeated step order goes back for revision.
- `llm_calls` columns `attempts`, `used_fallback` and `usage_estimated` (schema version 3; older databases are migrated in place).
- `npm run web:verify` (records the demo once, then web tests and build).
- `language.unit.test.ts`: no Portuguese in backend string literals or in the human-facing config files.

### Fixed

- **DNS rebinding.** A `Host` that is not a loopback name, `HOST` or one of `ALLOWED_HOSTS` gets 421; a write with a cross-site `Origin` gets 403.
- **Redaction.** Text is redacted before it is clipped (logs and MCP output), and a secret is also matched in its JSON-escaped form.
- **Runs left open by a crashed process** are closed as `abandoned` after `RUN_TIMEOUT_MS` + 60 s instead of blocking the incident for good.
- **Failed reverts after a failed canary** are written to the action, the `canary_rollback` audit (`revertFailedActionIds`) and the escalation detail.
- **LLM resilience.** A `buildUser` defect throws instead of posing as an outage; retries back off (500 ms base, jitter, `Retry-After`, capped at 10 s); 4xx other than 408/429 is not retried, and 401/402/403 skip the fallback; tokens of failed attempts are counted; missing usage is estimated and flagged; timeouts record the model that timed out.
- Remaining Portuguese strings in the trace, audit and post-mortem ("dry run failed", "failed", "unknown", "alert"), and in `.env.example`, the workflows, the pre-commit hook, `.npmrc` and the `package.json` description.

### Changed

- Version bumped to 0.3.0 in both packages.
- Every Portuguese code comment in `src/`, `tests/`, `scripts/` and `web/` is translated to English; the language test now also covers comments (with a short allowlist for the Portuguese decision words the parser accepts and the pt-BR number formats the numeric guard reads).

- `tsconfig.json` uses `module` and `moduleResolution` `nodenext`, so the typecheck rejects extensionless relative imports the way Node does.
- `mcp:inspect` pins `@modelcontextprotocol/inspector@2.13.0`.
- CI runs on pushes to `main` and on pull requests, with a concurrency group that cancels superseded runs; `verify` records the demo once.
- The Pages workflow runs the web typecheck, `check:tokens` and the web tests before building.
- Goldens regenerated: only the fake's estimated `promptTokens` changed (the auditor input now carries six rule checks).

## [0.2.0] - 2026-11-20

### Changed

- **War Room redesign: the strip board.** The replay now reads like a board of flight progress strips. Each agent turn is a strip, and the color of its holder says who held the authority: blue when the model proposes, green when code computes or enforces (runbook search, gate, executor, canary), amber when a human decides. Every holder also names the agent and its role in text, so color is never the only signal.
- **The gate strip.** When the replay stops at the approval gate, the gate's strip slides out of the bay with a `HOLD` mark and goes back stamped `APPROVED` or `REJECTED` after the decision.
- **Approval gate card.** Each step shows who proposed it, who set its tier (always the catalog) and who decides (code, a human, or nobody for tier 4). Approve and Reject sit apart, and tier 4 blocks are hatched as well as colored.
- **Held strip and gate side by side.** On wide screens, while the replay is held, the side column stays in view next to the strip bay, and the gate scrolls the held strip into view, so the held strip and the Approve and Reject buttons share the screen. Steps that do not wait for a human collapse to one line while held.
- **Numbers and post-mortem.** The numbers card is a list of rows (MTTR and time waiting for approval first), each with its source, under a "computed by code" label. The post-mortem uses two columns on wide screens: narrative on the left (summary, root cause, timeline), facts on the right (impact, actions, escalation, prevention).
- **New design tokens.** New light and dark palettes in `web/src/styles/tokens.css`. `contrast-pairs.json` now declares 28 pairs (up from 17), all at 4.5:1 or more in both themes.
- **Playback bar.** The bar stays visible while you scroll and shows a progress meter. Its live region announces only state changes (playing, paused, held at the gate, finished), never the per-event counter.
- **Narrow screens.** Below 960 px, the gate card moves above the strip bay while the replay is held, so Approve is reachable without scrolling past the whole conversation.
- Version bumped to 0.2.0 in both packages (`/health` and the MCP server read it from `package.json`).

### Fixed (backend, from the November 2026 review)

- **Circuit breaker could stay blocked until a restart (high severity).** Half-open, the breaker lets one trial through. If that trial ended without an outcome (the action was throttled, or it was a non-mitigating step such as `add_incident_note` followed by a blocked rollback), the breaker stayed half-open with its trial taken, and every later execution in the process, for every incident, ended as `blocked_circuit_open`. Now the whole execution batch is the trial: its remaining steps run, a failure reopens the breaker, the verifier records the outcome, and a batch with no outcome hands the trial back through the new `CircuitBreaker.releaseTrial()`. Five regression tests cover it.

- **Overdue sibling approvals are recorded when another decision resumes the batch.** Approving a later MCP proposal no longer resumes while an overdue gate approval stays `pending` in the store: it is recorded as expired (audit `approval_expired`), its action is `expired` and its dependents are cancelled.
- **A timeout or recursion-limit escalation closes the pending approvals.** They are expired with the cause in the audit, their actions are cancelled, and a decision on an escalated or resolved incident is refused with `incident_not_accepting`, so no audit entry can say a human approved an action that never ran.
- **`runbookRef` is now checked against the runbooks actually retrieved.** A planner or MCP client naming a runbook the retriever never returned no longer keeps a step at tier 2: it is raised to tier 3 with the reason "runbook reference not among the retrieved runbooks".
- **Unpriced real models are no longer silent.** With OpenRouter, a primary or fallback model missing from `data/model-prices.json` logs a startup warning (`llm_price_missing`); the README explains how to add prices.

### Fixed (War Room, from the November 2026 review)

- Pressing Play no longer drops keyboard focus to `<body>`: focus moves to Pause, and pausing returns it to Step.
- "Change scenario" returns focus to the "Choose a scenario" heading instead of losing it.
- The scenario picker is disabled while a recording loads, and only the latest request can apply its result.
- After the decision, gate steps show the decision (`APR-0001 approved by a human`) instead of a stale "awaiting" text.
- A failed index load shows a "Try again" button.
- During Play, the newest strip is kept in view (with an instant scroll under `prefers-reduced-motion`).

### Added

- `docs/code-review-2026-11.md`: the full review of the codebase, with 31 verified findings (1 high, 6 medium, 24 low), their status and suggested fixes, plus the 14 findings that verification rejected.
- `PRODUCT.md` (product context for design work) and `DESIGN.md` (the War Room design system).
- Eleven backend regression tests for the review fixes (351 backend tests: 270 unit, 81 end to end).
- Five War Room tests (37 in total): focus on Play and Pause, focus after Change scenario, the `HOLD` and `APPROVED` stamps, retry after an index failure, and the picker locked while loading.
- New README media: `docs/media/demo.gif`, `war-room.png`, `war-room-dark.png` and `war-room-mobile.png`.

### Docs

- Spec 007 no longer says the interface is in pt-BR; it is English only, as the constitution and `AGENTS.md` require.

## [0.1.0] - 2026-10-08

- First public version: LangGraph supervisor with telemetry, runbook, planner and auditor agents; Autonomy Matrix with a human approval gate; numeric guard; hash-chained audit; CLI, HTTP API, MCP server and the static War Room replay.
