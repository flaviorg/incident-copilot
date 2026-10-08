# Build post-mortems

This folder keeps **real** failures hit while building the project, written as blameless post-mortems. Nothing here is made up. The raw material is `notes.md`, where each failure was logged on the day, with symptom and cause, while the work was happening.

| No. | Title | Area |
|---|---|---|
| [0001](0001-fake-consumed-script-per-process.md) | The fake provider consumed the script per process, and the API's 2nd incident returned 500 | Fake provider, API and MCP |
| [0002](0002-focus-lost-at-the-gate.md) | Keyboard focus was lost at the War Room approval gate | War Room accessibility |

The other failures in `notes.md` were minor and stayed as notes only:

- `recursionLimit` inheritance test with the wrong topology;
- graph node named after a state key;
- strict mode checking every scenario;
- failed dry run case that did not get past the auditor;
- revert order checked through the wrong field;
- empty CSS in Vitest;
- cleanup command with a glob that zsh rejects;
- npm header on the stdout of `npm run mcp`;
- `fsevents` install script warning missing from the API notes;
- decision accepted during the opening run, found in the final review;
- `check:secrets` scanning the local `.env`, found in the final review.

## How to write a post-mortem

- **Blameless.** The text describes systems, assumptions and signals, not people. The question is "what made this possible?", not "who got it wrong?".
- **Facts only.** Anything not measured or recorded is left out or shown as "not recorded". Times go in only if they were logged.
- **Actions with an owner and proof.** Each action says what changed and which test keeps the problem from coming back.
- **Short.** One page is enough.

## Template

Copy the block below to `NNNN-<slug>.md`, with the next free number.

```markdown
# NNNN: <short title, in the past tense, describing the effect>

- **Date:** YYYY-MM-DD
- **Area:** <component or layer>
- **Severity:** <low | medium | high> (<why, in one sentence>)
- **Status:** <resolved | mitigated | open>

## Summary

Two or three sentences: what happened, who would be affected and how it ended.

## Impact

Who or what was affected, for how long and under what conditions. If nothing reached users (failure caught before publishing), say so and say who *would have* been affected.

## Timeline

Events in order, from the first signal to the verified fix. Use times only if they were recorded.

1. ...

## Cause

The technical cause and the assumption that made it possible. Why the existing tests or reviews did not catch it.

## What worked

Signals, tests, tools or practices that helped detect, understand or fix it.

## What did not work

What delayed detection or muddied the diagnosis.

## Actions

| Action | Type | Proof |
|---|---|---|
| ... | fix, prevention or detection | test or check that keeps it from coming back |

## Lessons

One or two sentences that apply to other projects.
```
