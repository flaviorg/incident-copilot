# 0001: The fake provider consumed the script per process, and the API's 2nd incident returned 500

- **Date:** 2026-10-04
- **Area:** fake provider (`src/llm/fake-provider.ts`), affecting the HTTP API and the MCP server
- **Severity:** medium. With the default provider, the API and MCP would serve only one incident per scenario until restarted. Caught before any publication.
- **Status:** resolved

## Summary

With the fake provider, the second `POST /incidents` for the same scenario, in the same API process, returned 500. The fake marked each script turn as consumed for the whole process. The second incident found the script already spent by the first, and the supervisor call threw `UnscriptedLlmCallError`. Matching now considers only the turns consumed by the incident itself.

## Impact

- **Nothing reached users:** the project had not been published.
- **Who would be affected:** anyone running `npm start` or `npm run mcp` with the default provider (`LLM_PROVIDER=fake`) who opened a second incident for the same scenario without restarting the process.
- **How it would show up:** as a 500 `internal_error`, with the details only in the log, because a fixture error is treated as a repository defect and does not become an escalation.
- **Out of scope:** the OpenRouter provider was not affected.
- **Why the demo did not show it:** the CLI and every test up to that point opened one incident per process.

## Timeline

All on 2026-10-04, during Task 33 (incident and approval routes). Times were not recorded.

1. A new test in `tests/e2e/http.e2e.test.ts` opens two `deploy-5xx-rollback` incidents on the same `buildServer`, to check that each request carries its own `X-Request-Id` into the trace and the audit.
2. The second `POST /incidents` returns 500. The test log shows `UnscriptedLlmCallError` in `supervisor.v1`, with "turns of this prompt 4/5 consumed".
3. The error message points to the prompt, the `matchKeys` and the consumed-turn count, and leads to the cause: the fake kept consumption in a single process-wide set.
4. A new unit test in `fake-provider.unit.test.ts` reproduces the scenario without HTTP: two incidents of the same script on the same provider.
5. Matching switches to the key `(incidentId, scenario, turn)`, and strict mode keeps using the union. Both tests go green, and the full suite stays green.

## Cause

The spec (section 7.2, rule 2) says the fake looks for "the first unconsumed turn of that prompt". The first implementation read "unconsumed" as "not consumed by anyone in this process". That was enough for the mental model of one incident per run, which held for every use up to Task 32:

- the `demo` CLI;
- the scenario tests;
- the War Room recorder.

The API and the MCP server broke that premise: they are long-running processes and serve several incidents. No earlier test opened two incidents of the same scenario in the same container, so the assumption was never exercised.

## What worked

- **An error with a diagnosis.** `UnscriptedLlmCallError` (spec rule 3) carries the prompt, the match keys and the consumed-turn count. That pointed straight to the cause.
- **The test that found the defect was written for something else:** propagating the `requestId`. An end-to-end test with a scenario slightly more realistic than the minimum caught the wrong premise.
- **Fixture error handling.** Keeping fixture errors apart from escalation made the problem surface as a loud, clear 500, instead of an "escalated" incident that would look like normal behavior.

## What did not work

- The scenario tests ran in strict mode, but with one incident per container. Strict mode proves the script was fully consumed, not that it can be consumed again.

## Actions

| Action | Type | Proof |
|---|---|---|
| Per-incident matching (`ctx.incidentId`); strict mode over the union of consumed turns | fix | `fake-provider.unit.test.ts` ("each incident replays the script from the start (same scenario, same process)") |
| HTTP test that opens the second incident of the same scenario in the same process, with its own `X-Request-Id` | detection | `http.e2e.test.ts` ("list, view, trace, audit and postmortem readiness") |
| Code comment and rule documented in `docs/fake-provider.md` | prevention | review |

## Lessons

A test double has lifecycle assumptions too. When the same component starts serving a long-running process, it pays to have a test that repeats the operation in the same process.
