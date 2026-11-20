# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

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
- Five War Room tests (37 in total): focus on Play and Pause, focus after Change scenario, the `HOLD` and `APPROVED` stamps, retry after an index failure, and the picker locked while loading.
- New README media: `docs/media/demo.gif`, `war-room.png`, `war-room-dark.png` and `war-room-mobile.png`.

### Docs

- Spec 007 no longer says the interface is in pt-BR; it is English only, as the constitution and `AGENTS.md` require.

## [0.1.0] - 2026-10-08

- First public version: LangGraph supervisor with telemetry, runbook, planner and auditor agents; Autonomy Matrix with a human approval gate; numeric guard; hash-chained audit; CLI, HTTP API, MCP server and the static War Room replay.
