# Scripted fake provider

`FakeLlmProvider` (`src/llm/fake-provider.ts`) is the default provider (`LLM_PROVIDER=fake`). It lets the demo and the whole test suite run without network or keys. It **proves the mechanics, not the model's quality**:

- graph flow, contracts, and caps;
- gate and approval machine;
- numbers, redaction, and audit.

Every response is written in a fixture. A call with no matching turn throws, so tests break when someone changes a prompt or the flow without updating the script.

## Fixture format

One file per scenario: `fixtures/llm/<scenario>.json` for the demo scenarios and `tests/fixtures/llm/*.json` for the four test-only scripts. The schema lives in `src/llm/fixture-format.ts`.

```json
{
  "schemaVersion": 1,
  "scenarioId": "deploy-5xx-rollback",
  "promptHashes": {
    "supervisor.v1": "sha256:<hash of version + \"\\n\" + system>",
    "telemetry-react.v1": "sha256:...",
    "planner.v1": "sha256:...",
    "auditor.v1": "sha256:...",
    "postmortem.v1": "sha256:..."
  },
  "turns": [
    {
      "id": "sup-1",
      "prompt": "supervisor.v1",
      "when": { "hasDiagnosis": false },
      "output": { "next": "telemetry_analyst", "brief": "...", "reason": "..." },
      "usage": { "promptTokens": 812, "completionTokens": 61 }
    },
    {
      "id": "tel-1",
      "prompt": "telemetry-react.v1",
      "when": { "run": 1, "step": 1 },
      "output": { "kind": "action", "thought": "...", "tool": "query_metrics", "args": { "service": "orders-api", "metric": "http_5xx_rate", "window": "30m" } }
    }
  ]
}
```

Turn fields:

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique identifier within the file. The schema rejects duplicate ids |
| `prompt` | yes | Prompt version (`supervisor.v1`, `planner.v1`, and so on) |
| `when` | yes | Condition: a subset of the call's `matchKeys`, with per-key equality |
| `output` or `error` | exactly one | Scripted output, or a simulated failure (`{ "kind": "timeout" \| "rate_limit" \| "server_error" \| "invalid_output" }`) |
| `usage` | no | Turn tokens. Without it, the fake estimates about 4 characters per token |
| `delayMs` | no | Delay before responding, abortable by the call's signal |

## Fake rules

1. **Prompt hash.** Before responding, the fake computes `"sha256:" + sha256(version + "\n" + system)` and compares it with `promptHashes[version]`. On mismatch, it throws `FixturePromptDriftError` with the prompt name and an instruction to run `npm run fixtures:rehash`. The output schema is not part of the hash.
2. **Matching.** The fake builds `prompt.matchKeys(input)` and searches, in file order, for the first turn of that prompt that **this incident** has not yet consumed and whose `when` matches. Consumption is per incident (`ctx.incidentId`). This way the API and the MCP server, which are long-running processes, can open several incidents of the same scenario. Each one plays the script from the start. This bug was found in block 4 (see `docs/incidents/0001-fake-consumed-script-per-process.md`).
3. **No turn.** The fake throws `UnscriptedLlmCallError` with the scenario, prompt, call number, SHA-256 digest of the full input, `matchKeys`, the prompt's total turns, and how many were already consumed.
4. **Validation.** The turn's output goes through the prompt's `outputSchema`, as if it came from the model. `tests/unit/contracts.unit.test.ts` checks every fixture (format, current hashes, and each turn's output against the schema). So an invalid fixture fails in the suite, not in the middle of the demo.
5. **Simulated failures.** A turn with `error` returns a failure of that kind. This is how tests exercise retry, fallback, and 503. `invalid_output` counts as a failed attempt, like an output that fails Zod.
6. **Delay.** With `delayMs`, the fake waits with `setTimeout`. If `ctx.signal` aborts first, it returns `aborted`. This is how tests trigger `LLM_TIMEOUT_MS` and `RUN_TIMEOUT_MS` for real, with an actual abort.
7. **Usage.** Turn tokens or estimated ones, cost 0, model `fake/scripted`.
8. **Strict mode.** `assertAllConsumed({ scenarioId })` throws, listing the turns no incident consumed. Scenario tests run in strict mode. Failure tests that stop midway through the script assert the exact list of consumed turns (`consumedIds()`).
9. **Input log (tests only).** `calls()` returns `{ prompt, matchKeys, user, turnId }` for each call. The injection test uses it to prove the hostile text reached the prompt.

## `matchKeys` per prompt

| Prompt | Keys | `when` example |
|---|---|---|
| `supervisor.v1` | `hasDiagnosis`, `runbookSearchDone`, `hasPlan`, `hasAudit`, `verified` | `{ "hasDiagnosis": true, "runbookSearchDone": false }` |
| `telemetry-react.v1` | `run` (1 or 2), `step` (1 to 12) | `{ "run": 1, "step": 3 }` |
| `planner.v1` | `revision` | `{ "revision": 1 }` |
| `auditor.v1` | `revision` | `{ "revision": 0 }` |
| `postmortem.v1` | `kind` (`final`) | `{ "kind": "final" }` |

The keys are deliberately small and stable: the full prompt text can change without breaking matching. The hash from rule 1 protects `system`.

## Patching in code: `patchFixture`

Failure paths do not multiply files. `tests/helpers/fixtures.ts` derives one fixture from another without changing the base:

```ts
import { errTurn, patchFixture, readFixture, turn } from "../helpers/fixtures.ts";

const base = readFixture("fixtures/llm/deploy-5xx-rollback.json");
const flaky = patchFixture(base, {
  replace: { "sup-1": { delayMs: 200 } },                         // RUN_TIMEOUT_MS=50 really aborts
  insertBefore: { "plan-0": [errTurn("plan-err", { revision: 0 }, "server_error")] },
  append: [turn("plan-1", { revision: 1 }, { /* output */ }, "planner.v1")],
  remove: ["pm-1"],
});
```

- `replace` changes fields of a turn. Passing `error` removes `output`, and vice versa.
- `remove` drops turns.
- `insertBefore` inserts turns before an anchor. A turn without `prompt` inherits the anchor's.
- `append` adds turns at the end.
- An unknown id throws, so a typo does not slip through silently.
- The result goes through the schema again.

Test-only scripts in `tests/fixtures/llm/`:

| File | What it exercises |
|---|---|
| `react-cap.json` | The analyst never reaches `final` in 12 steps. Step 3 calls a nonexistent tool and step 4 sends invalid arguments (AC-05, AC-07) |
| `guard-coercion.json` | The supervisor asks for `gate` without a plan, and the guard coerces it to the canonical route (AC-03) |
| `invented-numbers.json` | A narrative with an invented percentage, which the numeric guard rejects (AC-23) |
| `injected-logs.json` | A hostile log in the deploy scenario and a planner that includes `delete_backups` (AC-11) |

## When to run `fixtures:rehash` and `regen`

| Changed | Run | Why |
|---|---|---|
| The `system` text of a prompt in `src/prompts/v1/` | `npm run fixtures:rehash` | Updates the `promptHashes` of every fixture and prints `file prompt old -> new`. There is no interactive prompt: the Git diff is the review. A second run prints "no hash changed" |
| A prompt's input format or the graph flow | Edit the turns by hand | The hash does not cover this. `UnscriptedLlmCallError` tells you which prompt and which keys were missing |
| A metric formula, scenario, fixture, or action catalog | `npm run regen` | Regenerates `tests/golden/metrics.<scenario>.<branch>.json` and `docs/autonomy-matrix.md`. Review the diff before accepting |
| Code only, with no change in expected behavior | Nothing | If the golden breaks, behavior changed: investigate before running `regen` |

Rule of thumb: **fixtures change with prompts.** A commit that changes `src/prompts/v1/*` without touching `fixtures/llm/*` leaves the suite red.

## What the fake proves

- The graph flow, code-decided routes, caps, and escalation, with the trace and blackboard persisted.
- That the tier comes from the catalog and not the model, and that tier 4 never executes, even when the scripted plan includes it.
- The approval machine, the token, redaction, and the chained audit log.
- That numbers come from pure functions over the data and that the numeric guard rejects invented numbers.
- The LLM failure paths (timeout, `rate_limit`, `server_error`, invalid output), with retry, fallback, 503, and 504.

## What the fake does not prove

- **Model quality.** A real LLM may get the diagnosis wrong, pick a different specialist, or build a worse plan. The guards and the gate limit the damage, but do not guarantee correctness.
- **Spontaneous Reflection.** In the `cost-anomaly` demo, the auditor sends the plan back because the code rule `snapshot_before_delete` fails revision 0. The feedback text is scripted. With a real model, the LLM's verdict may differ, but it never loosens the rules' verdict.
- **Real timings.** The demo's MTTR comes from the simulated clock: 20 s per LLM call, 3 s per tool, 2 s per dry run, the catalog duration per execution, 180 s per approval, and 60 s of canary.
- **Real cost.** The fake costs 0. `data/model-prices.json` only comes into play with the real provider.

To check the contract against a real model, use `npm run test:live` with `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` in `.env`. The test asserts structure only: diagnosis category in the enum, steps in the catalog or blocked, and numeric guard passed or template used.
