# 0002: Keyboard focus was lost at the War Room approval gate

- **Date:** 2026-10-04
- **Area:** War Room (`web/src/App.tsx`), keyboard accessibility
- **Severity:** medium. Keyboard-only and screen reader users lost their place exactly at the moment of deciding. Caught before any publication.
- **Status:** resolved

## Summary

During the keyboard-only manual check, focus went to `body` when playback reached the approval gate. The Step button, which had focus, becomes disabled at that point. The same happened at the end of playback. The fix moves focus to the gate heading and to the post-mortem heading, and keeps focus on Step when a recording is loaded or a branch is chosen.

## Impact

- **Nothing reached users:** the War Room had not been published.
- **Who would be affected:** anyone using the War Room by keyboard or with a screen reader.
- **What would happen:** on reaching the gate, they would lose their place on the page and have to Tab from the top again to find Approve and Reject. At the end, the same would happen before the post-mortem.
- **Out of scope:** nothing changed for mouse users.

## Timeline

All on 2026-10-04, during Task 41 (App, build and Pages). Times were not recorded.

1. The War Room automated tests pass: components, axe with no violations, dialog with trapped focus and the full `App` flow on both branches.
2. The manual check required by the plan starts: both scenarios on both branches, using only Tab, Shift+Tab, Enter and Escape, at 1280 px and 375 px.
3. At 1280 px, on reaching the gate through the Step button, focus goes to `body`, and the next Tab starts over from the top of the page.
4. The cause is identified: a button that becomes `disabled` while focused loses focus, and no code moves it. The same happens at the end of playback.
5. A new test in `web/src/test/App.test.tsx` is written and seen failing: after the last Step before the gate, the active element should be the gate heading.
6. The fix lands in `App.tsx` and the test goes green.

## Cause

`PlaybackControls` disables Step and Play when playback stops at the gate or finishes, which is correct: there is no next step. The browser removes focus from an element that becomes disabled, and `App` had no rule about where focus should go after that.

The automated tests did not catch it for two reasons:

- `user-event` clicks buttons by reference and does not depend on where focus is;
- axe checks structure and accessible names, not the focus path over time.

## What worked

- **The keyboard-only manual check,** planned as a mandatory step, not an optional one. It found the defect, not the automated tests.
- **Headings with stable ids.** The gate (`gate-title`) and the post-mortem (`postmortem-title`) already had headings with ids and `aria-labelledby`, which gave natural focus targets.

## What did not work

- The full `App` flow test checked content and branches, but never asked "where is focus now?".

## Actions

| Action | Type | Proof |
|---|---|---|
| Focus on Step on load and on branch choice; on the gate heading when stopped; on the post-mortem heading at the end | fix | `App.test.tsx` ("keeps keyboard focus where the action is: step button, gate and postmortem"), written before the fix |
| Manual keyboard checklist in `docs/accessibility.md`, with the date and what was observed | detection | review on every War Room change |

## Lessons

A button that disables itself is a focus-loss point. Every state change that disables the focused element must say where focus goes, and a test should check `document.activeElement`, not just the on-screen content.
