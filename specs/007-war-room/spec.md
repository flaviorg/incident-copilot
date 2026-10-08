# 007: War Room lite

Milestone M7. Status: implemented.

## Context

Whoever evaluates the project has two minutes and may not run anything. The War Room is a static page, publishable on GitHub Pages, that replays runs recorded by the backend itself:

- the conversation between agents;
- the approval gate, with the approve and reject branches;
- the numbers;
- the post-mortem.

It makes clear, on every screen, that it is a replay with a fake provider. Since the recordings carry backend output, this milestone also proves that no secret leaves the process through any of the 7 surfaces.

## Scope

- `DemoRecorder` (`recordScenario` and `recordAll`, in `src/app/demo-recorder.ts`) and CLI `record-demo`. They record the 2 scenarios with deterministic clock and ids, with a common prefix and two branches, validated by `DemoRecordingSchema`. They are generated at build time and not versioned.
- Secret test across the 7 surfaces: HTTP, MCP, trace, audit, logs, reports and recordings.
- Nested `web/` package, no workspace: React 19, Vite 8, Vitest 5 and jsdom.
  - Design tokens in `tokens.css`, light and dark themes.
  - `check:tokens` fails on a literal color outside `tokens.css`.
  - Contrast test for the declared pairs.
- Replay (`replay-engine.ts`) with a pause at the gate and branch choice. Demo source that only fetches `./demo/` and validates with Zod.
- 9 accessible components:
  - `ModeBanner`, `ScenarioPicker`, `PlaybackControls`;
  - `AgentConversation`;
  - `ApprovalGate`, `ApprovalDialog`, `TierBadge`;
  - `MetricsCards`, `PostmortemView`.
- `.github/workflows/pages.yml`, manual dispatch only.

## Non-goals

- Live mode against the local API, `SettingsDialog` and token field (v2 backlog).
- `Tabs`, `Sparkline`, filterable trace table and `prefers-reduced-motion` test (v2 backlog).
- Real browser tests (Playwright or Cypress).
- Internationalization: the interface is in pt-BR.
- Computing metrics in the browser: the War Room only shows what the recording carries.

## Acceptance criteria (EARS)

- **AC-17** The system shall never include the value of `APPROVAL_TOKEN` or `OPENROUTER_API_KEY` in HTTP responses, MCP output, trace, audit, logs, reports or demo recordings, even when the value is sent in a text field.
- **AC-39** While in demo mode, the War Room shall show on every screen the label "Replay of a recorded run with a scripted fake provider", fetch only files from `./demo/`, reject with an explicit error any recording that fails `DemoRecordingSchema`, trap focus in the approval dialog (ESC closes it and returns focus), convey the tier through text and icon in addition to color, and use color pairs with a minimum contrast of 4.5:1.

Manual verification, with no automated criterion: below 600 px the War Room uses a single column, with no horizontal scrolling, and everything is keyboard operable. The record is in `docs/accessibility.md`.

## How to verify

| Criterion | Tests |
|---|---|
| AC-17 | `tests/e2e/secrets.e2e.test.ts` ("no secret value appears in any output surface"); `tests/unit/redact.unit.test.ts` |
| AC-39 | `tests/e2e/demo-recordings.e2e.test.ts`; `web/src/test/demo-source.test.ts`; `web/src/test/replay-engine.test.ts`; `web/src/test/ApprovalDialog.test.tsx`; `web/src/test/components.test.tsx` (axe); `web/src/test/tokens-contrast.test.ts`; `web/src/test/App.test.tsx` |

Demonstrable milestone: `npm run web:demo` shows the 2 scenarios with approve and reject; `VITE_BASE=/incident-copilot/ npm run web:build` generates the site with the recordings in `web/dist/demo`.

## Reference

incident-copilot design document, revision 2, dated 2026-10-04. It lives in the course repository, outside this repository. Sections:

- "6.6 Secrets and redaction";
- "7.6 Generated artifacts";
- "10.2 What the War Room demo shows";
- "8.3 Acceptance criteria in EARS".

Accessibility evidence in `docs/accessibility.md`.
