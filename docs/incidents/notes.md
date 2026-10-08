# Notes on real failures during the build

Raw material for the post-mortems (Task 42). Only facts that happened, with date, symptom and cause.

## 2026-10-04: `recursionLimit` inheritance test passed without throwing

- **Symptom:** in `api-assumptions.unit.test.ts`, the think/act subgraph with 12 actions inside one node did not throw `GraphRecursionError` with the parent at 25.
- **Cause:** the test topology ended at the `act` node (12 think + 12 act = 24 supersteps), one short of the limit. A real ReAct loop ends on a `think` that emits the final answer (25 supersteps), and that is where it overflows.
- **Fix:** `think` decides between an action and the end; the test also asserts that, with the parent at 100, the same subgraph finishes, which proves inheritance and not just the default of 25.

## 2026-10-04: graph node with the same name as a state key

- **Symptom:** the plan (Task 22) named the graph nodes after the `AgentId`s (`supervisor`, `escalation`). A probe before writing `graph.ts` showed that `addNode("supervisor", ...)` throws "supervisor is already being used as a state attribute (a.k.a. a channel), cannot also be used as a node name".
- **Cause:** LangGraph uses the same namespace for state channels and nodes, and `supervisor` and `escalation` are keys of `BlackboardSchema`, which is a spec 5.2 contract and does not change.
- **Fix:** routes still return the logical name (`NodeName`); `GRAPH_NODE_ID` in `src/graph/routing.ts` gives the registered id (`supervisor_agent`, `escalation_node`) and each edge's `pathMap` does the translation. One test in `api-assumptions.unit.test.ts` and another in `routing.unit.test.ts` lock the behavior.

## 2026-10-04: the fake's strict mode checked every scenario's script

- **Symptom:** at the first green of Task 22, `c.fake.assertAllConsumed()` in the deploy scenario test failed, listing the turns of `cost-anomaly` (and vice versa).
- **Cause:** the test container loads the fixtures of every scenario, and `assertAllConsumed` walked all the files.
- **Fix:** a `scenarioId` option on `assertAllConsumed`, which checks only the script of the scenario that ran; new test in `fake-provider.unit.test.ts`.

## 2026-10-04: the plan's "failed dry run" case did not get past the auditor

- **Symptom:** the plan (Task 29, and spec 7.4) asks for an end-to-end test with `patchFixture` switching the rollback to `v9.9.9` and expects `[succeeded, rejected_by_dry_run, cancelled]`, with no approval. Reading the `rollback_requires_recent_deploy` rule before writing the test made it clear that the auditor rejects that plan: `toVersion` must be the version before the suspect deploy (`v3.7.2`). The fake would request `plan-1`, which does not exist, and the test would break with `UnscriptedLlmCallError`.
- **Cause:** the auditor rules mirror the dry run checks (target exists, version in the history), so no tier 3 step in the catalog fails the dry run and passes the auditor with the scenario data. It was an oversight in the plan, not in the library.
- **Fix:** the pure case (failed dry run with no approval, dependent cancelled) stayed in the node test (`nodes-gate.unit.test.ts`, with the state built after the auditor). In the end-to-end test, the fixture scripts revisions 1 and 2 with the same plan; once revisions run out, every step goes up to tier 3, the rollback ends `rejected_by_dry_run` with no approval, the dependent is cancelled and only the note asks for approval. Once the note is approved, the incident escalates with `no_executable_actions`.

## 2026-10-04: revert order test looked at the wrong order

- **Symptom:** at the first green of Task 28, the failed canary test failed: it expected `["block_image_tag", "rollback_deployment"]` and got `["rollback_deployment", "block_image_tag"]`.
- **Cause:** the test (copied from the plan text) filtered `actions` by `reverted`, and `filter` keeps the plan order. The revert itself was correct, in reverse `executedAt` order.
- **Fix:** the revert order is asserted through the verifier's `revert:<type>` events in the trace and through `verification.revertedActionIds`.

## 2026-10-04: second incident of the same scenario on the API returned 500

- **Symptom:** in the Task 33 test that opens two `deploy-5xx-rollback` incidents on the same `buildServer`, the second `POST /incidents` returned 500. The log showed `UnscriptedLlmCallError` in `supervisor.v1`, "turns of this prompt 4/5 consumed".
- **Cause:** `FakeLlmProvider` marked turns as consumed per process. The CLI and the tests always opened one incident per container, so nobody had seen it. But the API and the MCP server are long-running processes: with the fake, a scenario's second incident found the script spent by the first.
- **Fix:** matching (spec 7.2, rule 2) now looks at the turns consumed by the incident itself (`ctx.incidentId`), so each incident plays the script from the start. Strict mode still looks at the union (turn consumed by any incident). New test in `fake-provider.unit.test.ts`; the HTTP test opens the second incident in the same process.

## 2026-10-04: contrast test read an empty tokens.css

- **Symptom:** in Task 38, the token contrast test failed with "token --color-text missing from the light theme", even though the token was in the file.
- **Cause:** the test imported `../styles/tokens.css?raw`, so it would not depend on Node types in the `web` package. By default, Vitest replaces every CSS file with an empty string, including with `?raw`. A diagnostic assertion showed length 0.
- **Fix:** `test.css: true` in `web/vite.config.ts`. The test now reads the real file. Logged in `docs/api-notes.md`.

## 2026-10-04: keyboard focus was lost at the gate and at the end of playback

- **Symptom:** in the Task 41 manual check, keyboard only, at 1280 px, focus went to `body` when playback reached the gate. The Step button, which had focus, becomes disabled at that point. Screen reader users lost their place and had to Tab from the top again.
- **Cause:** a disabled button loses focus, and no code moved it elsewhere. The automated tests clicked the buttons and did not notice.
- **Fix:**
  - On loading a recording or choosing a branch, focus goes to Step.
  - At the gate, it goes to the "Approval gate" heading, and the next Tab reaches Approve.
  - At the end, it goes to the post-mortem heading.
  - New test in `web/src/test/App.test.tsx`, written before the fix and seen failing.

## 2026-10-04: the plan's cleanup command did not run in zsh

- **Symptom:** in Task 47, the "clean and install from the lockfile" step (`rm -rf node_modules ... data/*.db data/*.db-* && time (...)`) stopped immediately with `no matches found: data/*.db`. Nothing was deleted or installed.
- **Cause:** zsh, the macOS default shell, treats a glob with no match as an error and does not run the command. There was no database in `data/`. In `bash`, an unmatched glob passes through literally and `rm -rf` ignores it.
- **Fix:** the check ran in `bash` with `shopt -s nullglob`. The README command for S1 uses no glob. Logged in `docs/api-notes.md`.

## 2026-10-04: `npm run mcp` did not leave stdout empty

- **Symptom:** in the retry of block 4, `npm run mcp < /dev/null` wrote 82 bytes to stdout: the `> incident-copilot@0.1.0 mcp` header and the command line, which are not JSON-RPC. The block 4 log and the README said stdout stayed empty, or carried only JSON-RPC.
- **Cause:** the header comes from npm 11.19.0, not from the server. The earlier check looked at the `node` process, whose stdout is indeed empty, and extended the conclusion to the npm script. The AC-34 test starts bare `node`, so it does not catch the header. An MCP client configured with `npm run mcp` would receive two non-JSON-RPC lines before `initialize`.
- **Fix:** documentation only, because the script follows spec 8.4 and the `.vscode` and `.cursor` configurations already call `node` directly. The README and `docs/api-notes.md` now point to `node` directly or `npm run -s mcp`, whose stdout was checked to be empty.

## 2026-10-04: the API notes said no web package needed an install script

- **Symptom:** in the retry of block 5, step 1 of Task 47 (delete `node_modules` and `web/node_modules`, then `npm ci && npm --prefix web ci && npm run verify`) exited with code 0. But `npm --prefix web ci` warned "1 package has install scripts not yet covered by allowScripts: fsevents@2.3.3". `docs/api-notes.md` said, in blocks 4 and 5, that no web package needed an install script.
- **Cause:** `fsevents` is an optional Vite dependency, macOS only, and `web/package-lock.json` marks it with `hasInstallScript: true`. The published package has no `install` script or `binding.gyp` and already ships the compiled `fsevents.node`, so there is nothing to run and the build works. Why the earlier checks did not see the warning was not recorded. In this run, it shows up right after the `npm --prefix web ci` summary, before the `verify` output.
- **Fix:** documentation only. `docs/api-notes.md` describes the warning and why it is harmless. `allowScripts` was not touched, and the script was not approved.

## 2026-10-04: a decision accepted during the opening run left the incident inconsistent

- **Symptom:** in the final review, a probe with the real gate followed by a 150 ms pause saw `APR-0001` pending in `GET /approvals` while `POST /incidents` was still running. A decision in that window returned 200, and `POST /incidents` returned 409 `version_conflict`. The incident stayed `open`, with a blackboard without actions, 3 rows in `actions`, an `approved` approval, an audit saying executed and escalated, and the `runs` row with no outcome. No API call recovered it.
- **Cause:** the gate writes approvals, actions and audit in the middle of the run, but the blackboard is only written at the end, with an optimistic version. The decision changed the blackboard under the run, and the routing after the gate read zero pending items and sent the batch to the executor within the opening run. Without the pause, the window is under one second (gate, end of graph, save), which is why the concurrent decisions test did not catch it. Also, `run()` only closed the `runs` row after the final save.
- **Fix:** `applyDecision` and `expireDueApprovals` refuse with 409 `incident_not_accepting`, writing nothing, when the incident has an unfinished `runs` row. `run()` also closes the `runs` row when the final save throws. Two new tests in `tests/e2e/gate.e2e.test.ts`, with the real gate followed by a hook in the same superstep, written before the fix and seen failing.

## 2026-10-04: `check:secrets` broke the pre-commit for anyone following the README

- **Symptom:** in the final review, with a `.env` filled in as "Using a real model" says, `npm run check:secrets`, the pre-commit and `npm run verify` exited with code 1 (`.env:1` and `.env:3`).
- **Cause:** the scan walks the tree without `git ls-files` (the folder lives inside the course repository) and ignored `reports`, `web/dist`, `web/public/demo`, `coverage` and `data/*.db`, but not `.env`, which is in `.gitignore`. The tests ran on a tree without `.env`.
- **Fix:** the local `.env` stays out of the scan while Git does not track it (`git ls-files --error-unmatch`); once tracked, it is scanned again. `.env.example` is still scanned. Two new tests in `tests/unit/check-secrets.unit.test.ts`, seen failing first.
