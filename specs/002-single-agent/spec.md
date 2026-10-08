# 002: Single agent

Milestone M2. Status: implemented.

## Context

Before the team, a single agent must investigate reliably: the telemetry analyst in a ReAct loop over the read tools from spec 001. This milestone also pins down the LLM contract:

- versioned prompts;
- structured output validated by Zod;
- retry, fallback and timeout;
- the scripted fake provider, which lets the suite and the demo run without network.

## Scope

- `LlmProvider`, with two providers:
  - `FakeLlmProvider`: prompt hash, matching by `matchKeys`, errors with diagnostics, simulated failures, abortable `delayMs`, strict mode and input recording;
  - `OpenRouterProvider`: `ChatOpenAI` with `baseURL` and `withStructuredOutput`.
- `withTimeout`, `withRetry` (2 attempts on the primary) and fallback in `resilient` (1 attempt on the backup model), in `src/llm/resilience.ts`. Each logical call becomes one row in `llm_calls`.
- Prompts `src/prompts/v1/*` (`supervisor.v1`, `telemetry-react.v1`, `planner.v1`, `auditor.v1` and `postmortem.v1`), with input and output schemas. `npm run fixtures:rehash`.
- `TraceSink`: validates, redacts, numbers and persists events.
- `telemetry_analyst` node with a ReAct loop of up to 12 steps inside the node. A tool error becomes an observation. The observation enters the next prompt as delimited data.
- CLI `diagnose`.

## Non-goals

- Native model tool calling: ReAct uses structured output, so it works with models without tool calling and the fake can script each step.
- A subgraph for ReAct: it would inherit the parent graph's `recursionLimit` and blow up before the 12th step.
- Model quality evaluation or benchmarks: `test:live` only checks structure.
- Episodic memory, rolling summary or `ContextBuilder`.
- Token streaming.

## Acceptance criteria (EARS)

- **AC-05** If the analyst completes 12 ReAct steps without a final answer, then the system shall end the loop without throwing `GraphRecursionError`, record a diagnosis with `confidence: "low"` and `capReached: true`, and escalate with `react_cap_low_confidence` without calling the planner.
- **AC-07** When a tool fails, does not exist or receives invalid arguments, the system shall return the problem as an `observation` with `ok: false` and continue the loop.
- **AC-26** If the fake receives a call with no matching scripted turn, or if the hash of `version + system` differs from the recorded one, then it shall throw `UnscriptedLlmCallError` (with scenario, prompt, call number, digest and keys) or `FixturePromptDriftError` before answering.
- **AC-28** If a strict-mode scenario test ends with unconsumed turns, then the test shall fail listing their ids.
- **AC-29** If the primary model fails twice, then the system shall try the fallback model; if that also fails, it shall mark the incident `escalated` with `llm_unavailable`, generate a partial post-mortem from the template, and the API shall respond 503.
- **AC-31** When the LLM's structured output fails `safeParse`, the system shall treat it as a failed attempt and never use unvalidated data.

## How to verify

| Criterion | Tests |
|---|---|
| AC-05 | `tests/e2e/telemetry.e2e.test.ts` ("12 steps without final: low confidence, capReached, and no GraphRecursionError inside a graph with recursionLimit 25"); `tests/e2e/team.e2e.test.ts` ("react cap escalates without calling the planner") |
| AC-07 | `tests/unit/tools.unit.test.ts` ("invalid args and unknown tools are observations, not exceptions"); `tests/e2e/telemetry.e2e.test.ts` |
| AC-26 | `tests/unit/fake-provider.unit.test.ts` ("unscripted call throws with diagnostics", "prompt drift throws before answering") |
| AC-28 | `tests/unit/fake-provider.unit.test.ts` ("assertAllConsumed lists leftovers and honors except"); `tests/e2e/scenarios.e2e.test.ts` |
| AC-29 | `tests/unit/resilience.unit.test.ts` ("falls back after two primary failures", "fails when primary and fallback fail"); `tests/e2e/resilience.e2e.test.ts` (503) |
| AC-31 | `tests/unit/resilience.unit.test.ts` ("OpenRouterProvider maps usage, invalid output and HTTP errors"); `tests/unit/fake-provider.unit.test.ts` ("simulated errors and schema-invalid outputs are failures") |

Demonstrable milestone: `npm run cli -- diagnose --scenario deploy-5xx-rollback` prints thought, action and observation for the 3 steps and the `bad_deploy` diagnosis with high confidence.

## Reference

incident-copilot design document, revision 2, dated 2026-10-04. It lives in the course repository, outside this repository. Sections:

- "4.3 Interfaces between components";
- "6.2 Caps";
- "7. Fake provider", especially "7.2 Fixture format";
- "8.3 Acceptance criteria in EARS".

The fixture format and the fake's rules are in `docs/fake-provider.md`.
