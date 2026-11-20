# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
