---
name: incident-copilot War Room
description: A flight-progress strip board that replays a recorded incident and shows who acted at every step.
colors:
  board: "#d3dae2"
  bay: "#c2cbd5"
  strip-white: "#fbfcfd"
  strip-muted: "#edf1f5"
  border-slate: "#7d8896"
  rule-hairline: "#dbe1e8"
  ink: "#141c26"
  ink-muted: "#47515e"
  accent-ink: "#17202b"
  accent-on: "#ffffff"
  link-blue: "#1f4fb0"
  focus-blue: "#1f4fb0"
  danger-red: "#a8301d"
  danger-on: "#ffffff"
  success-green: "#17643f"
  banner-night: "#141c26"
  banner-text: "#f1f4f7"
  banner-tag: "#ffd27a"
  auth-model: "#2b5cbf"
  auth-code: "#1b6e49"
  auth-human: "#8f5306"
  auth-system: "#4f5a68"
  auth-on: "#ffffff"
  held-ring: "#8f5306"
  held-text: "#7a4604"
  stamp-approved: "#17643f"
  stamp-rejected: "#a8301d"
  tier-1-bg: "#e4ecfb"
  tier-1-fg: "#1d3f86"
  tier-2-bg: "#e1f1e8"
  tier-2-fg: "#14532d"
  tier-3-bg: "#fbecd6"
  tier-3-fg: "#6e3f04"
  tier-4-bg: "#f9e3df"
  tier-4-fg: "#86231a"
  hatch: "#9aa5b2"
typography:
  headline:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 750
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  card-title:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 750
    lineHeight: 1.2
  body:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "tnum"
  strip-text:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "tnum"
  label:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 700
    lineHeight: 1.2
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  strip: "4px"
  card: "8px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "24px"
  "6": "32px"
  "7": "48px"
components:
  strip:
    backgroundColor: "{colors.strip-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.strip}"
  strip-holder-model:
    backgroundColor: "{colors.auth-model}"
    textColor: "{colors.auth-on}"
    padding: "8px 12px"
    width: "9.5rem"
  strip-holder-code:
    backgroundColor: "{colors.auth-code}"
    textColor: "{colors.auth-on}"
    padding: "8px 12px"
    width: "9.5rem"
  strip-holder-human:
    backgroundColor: "{colors.auth-human}"
    textColor: "{colors.auth-on}"
    padding: "8px 12px"
    width: "9.5rem"
  strip-holder-system:
    backgroundColor: "{colors.auth-system}"
    textColor: "{colors.auth-on}"
    padding: "8px 12px"
    width: "9.5rem"
  bay:
    backgroundColor: "{colors.bay}"
    rounded: "{rounded.card}"
    padding: "12px"
  card:
    backgroundColor: "{colors.strip-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
  card-head-held:
    backgroundColor: "{colors.auth-human}"
    textColor: "{colors.auth-on}"
    padding: "12px 16px"
  button:
    backgroundColor: "{colors.strip-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "8px 16px"
    height: "40px"
  button-primary:
    backgroundColor: "{colors.accent-ink}"
    textColor: "{colors.accent-on}"
    rounded: "{rounded.card}"
    padding: "8px 16px"
    height: "40px"
  button-approve:
    backgroundColor: "{colors.auth-code}"
    textColor: "{colors.auth-on}"
    rounded: "{rounded.card}"
    padding: "8px 16px"
    height: "40px"
  button-reject:
    backgroundColor: "{colors.strip-white}"
    textColor: "{colors.danger-red}"
    rounded: "{rounded.card}"
    padding: "8px 16px"
    height: "40px"
  tier-badge-1:
    backgroundColor: "{colors.tier-1-bg}"
    textColor: "{colors.tier-1-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
  tier-badge-2:
    backgroundColor: "{colors.tier-2-bg}"
    textColor: "{colors.tier-2-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
  tier-badge-3:
    backgroundColor: "{colors.tier-3-bg}"
    textColor: "{colors.tier-3-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
  tier-badge-4:
    backgroundColor: "{colors.tier-4-bg}"
    textColor: "{colors.tier-4-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
  computed-by-chip:
    backgroundColor: "{colors.auth-code}"
    textColor: "{colors.auth-on}"
    typography: "{typography.label}"
    rounded: "{rounded.strip}"
    padding: "1px 8px"
  mode-banner:
    backgroundColor: "{colors.banner-night}"
    textColor: "{colors.banner-text}"
    padding: "8px 0"
---

# Design System: incident-copilot War Room

## Overview

**Creative North Star: "The Strip Board"**

The War Room is an air-traffic flight-progress strip board, moved onto an incident. Every agent turn is a white paper strip set into a slate bay, and the coloured holder on its left edge says who acted: the model proposes (blue), code computes and enforces (green), a human decides (amber), the system or an outside client is neutral slate. The board's job is to make authority legible at a glance, so colour is spent on authority and on nothing else; everything that is not a holder, a tier, or a decision mark stays slate and ink.

The density is operational, not editorial. Strips are tight (6px apart, 4px corners), times and numbers run in tabular figures, and folded details keep a long run scannable for an on-call engineer while the holder column alone tells an evaluator the story in two minutes. The one dramatic gesture is physical: when the replay stops at the approval gate, the gate strip is pulled out of the bay, ringed in amber and marked HOLD; after the human decides it slides back and carries an APPROVED or REJECTED stamp.

The system rejects the category default of a neutral timeline with grey status pills. It also refuses to let colour carry meaning alone: every holder names its role in text, every tier badge carries "Tier N" and an icon.

**Key Characteristics:**
- Slate board, white strips, solid authority-coloured holders with agent name and role line.
- Colour means authority (model, code, human, system) or tier; never decoration.
- One strip per agent turn; newest at the bottom.
- The held strip slides out (transform offset) with a HOLD stamp, then returns stamped with the decision.
- Numbers are provenance rows, each with its source, under a "computed by code" chip.
- Light and dark themes from `prefers-color-scheme`; every text/background pair verified at 4.5:1 in both.

## Colors

A cool slate board with four saturated authority holders and four pale tier tints; all values live only in `web/src/styles/tokens.css`, and each theme redefines the same names.

### Primary (authority holders)
- **Proposal Blue** (auth-model): holder of every model turn (supervisor, analysts, planner, auditor) and the "Proposed by model" cell. Identical in both themes.
- **Enforcement Green** (auth-code): holder of code turns (the remediation gate, rule critics), the "Tier set by catalog" and "Decided by code" cells, the "computed by code" chip, and the Approve button. Identical in both themes.
- **Decision Amber** (auth-human): holder of human turns, the "Decided by a human" cell, and the head of the held gate card. Identical in both themes.
- **System Slate** (auth-system): holder for system turns, the MCP-client proposer, and the scenario severity block on picker strips.
- **Holder White** (auth-on): the only text colour on holders; verified at 4.5:1 against all four.

### Secondary (decision marks)
- **Hold Amber** (held-ring, held-text): the ring around the pulled strip and the held gate card, the HOLD stamp, held status text. Brightens in dark (#f0a33a ring, #ffc978 text).
- **Stamp Green / Stamp Red** (stamp-approved, stamp-rejected): APPROVED and REJECTED stamps; same values as success and danger.

### Tertiary (tiers)
- **Tier tints** (tier-1 to tier-4, bg/fg pairs): pale blue (read-only), pale green (decides and logs), pale amber (requires a human), pale red (forbidden). Dark theme swaps to deep tints with light foregrounds.
- **Hatch Slate** (hatch): the 1px diagonal stripe in the forbidden tier-4 block.

### Neutral
- **Board Slate** (board): page ground.
- **Bay Slate** (bay): the recessed rack that holds strips, the playback bar, the scenario list.
- **Strip White** (strip-white): strips, cards, dialog, post-mortem sheet.
- **Strip Muted** (strip-muted): neutral gate head, dry-run and code wells, disabled buttons, "nobody" authority cell.
- **Ink / Ink Muted** (ink, ink-muted): primary and secondary text; muted carries times, metadata and sources.
- **Accent Ink** (accent-ink): the primary Step button; inverts to near-white in dark.
- **Border Slate / Rule Hairline**: control borders and 1px dividers inside strips and cards.
- **Banner Night / Banner Tag**: the replay mode banner and its pale-gold "Replay" tag.
- **Link / Focus Blue** (link-blue, focus-blue): links and the 3px focus outline.

### Named Rules
**The Holder Rule.** Authority colour belongs on a solid holder block (strip holder, authority cell, chip, held gate head) with white text that names the role. Never tint body text or borders with an authority colour to imply who acted.

**The Paired Contrast Rule.** A new text/background combination is added to `contrast-pairs.json` and passes 4.5:1 in both themes before it ships. No literal colour outside `tokens.css`.

## Typography

**Body Font:** system UI stack (system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial)
**Label/Mono Font:** ui-monospace, SFMono-Regular, Menlo, Consolas

**Character:** Plain and instrument-like: one sans family carried by weight (500 to 800) rather than by face, with tabular figures everywhere so times and numbers align down the board. Mono is reserved for code-ish truth: action identifiers, tool names, dry-run output, arguments.

Open decision: the face is the system stack because the owner has not opted into a webfont. This is not a rule; a dedicated face (with its own justification and exact version, per the dependency policy) may replace it.

### Hierarchy
- **Headline** (700, 1.75rem, 1.2, -0.015em): incident title, picker headline, post-mortem title.
- **Title** (750, 1.25rem, 1.2): masthead, dialog title, key metric values, scenario titles.
- **Card title** (750, 1rem): bay and card heads, post-mortem section heads.
- **Body** (400, 1rem, 1.5, tabular): prose; post-mortem lines capped at 70ch, scenario summaries at 72ch.
- **Strip text** (400, 0.875rem, 1.5): event lines, metadata rows, legend; event kinds at 650.
- **Label** (700 to 800, 0.8125rem): tier badges, chips, stamps, times, sources, holder role lines (500).

### Named Rules
**The Tabular Rule.** Body sets `font-variant-numeric: tabular-nums`; never switch it off for times, counts or money.

**The Mono Means Machine Rule.** Monospace is only for identifiers and outputs a machine produced (action types, tools, JSON args, dry runs).

## Layout

One column by default; nothing scrolls sideways below 600px. Content caps at 1280px with 16px side padding, 24px from 600px. At 960px the main area splits into the strip bay (about 1.65fr) and a side column (minmax 320px, 1fr) with the gate card and numbers; while held, the side column is sticky beside the held strip. Below 960px, while held, the side column moves above the bay so the decision comes first. Below 600px strip holders collapse into a horizontal header row above the strip body, and the held offset shrinks from 16px to 8px. The playback bar is sticky at the top.

Spacing is a 4px-based scale (4, 8, 12, 16, 24, 32, 48). Strips stack 6px apart; strip bodies are a 4.75rem time column plus the event; the holder column is 9.5rem.

## Elevation & Depth

Depth is physical and shallow: strips sit in a recessed bay (darker slate) and lift off it with a tight two-layer shadow. A larger raised shadow marks only things that have been pulled out of place: the held strip, the held gate card, a hovered scenario strip, the dialog. Dark theme deepens both shadows.

### Shadow Vocabulary
- **Strip** (`box-shadow: 0 1px 2px #141c2633, 0 1px 1px #141c261a`): every strip, card, the playback bar, the primary button on hover.
- **Raised** (`box-shadow: 0 8px 20px #141c2633, 0 2px 4px #141c261f`): pulled-out or modal elements only.

### Named Rules
**The Pulled Strip Rule.** Raised elevation means "taken out of the rack". It pairs with a transform offset (translateX) or a modal; it is not a generic card hover.

## Shapes

Two radii: strips and inner wells at 4px, containers (bay, cards, buttons, playback bar, dialog) at 8px. Pills (999px) only for tier badges and the post-mortem seal. Stamps are 3px-cornered boxes with a 2px currentColor border, rotated -3deg like an ink mark. The forbidden tier-4 block is a dashed-border box filled with a 135deg hatch. Holders are flush, square-edged blocks clipped by the strip's overflow.

## Components

### Flight strip (signature)
Character: a paper strip in a rack. White, 4px corners, strip shadow; a 9.5rem solid holder on the left with the agent name (750) and role line (500, xs) in white; the body is a list of events, one row each, time column then content, separated by hairline rules. Consecutive events from the same agent share one strip (one strip per turn). Thoughts, actions, observations, plans and answers fold behind a summary with a CSS caret. New strips slide in from 16px left over 420ms.

### Held gate strip
While the replay is held, the gate strip translates 16px right (8px on mobile), takes the raised shadow and a 2px amber inset ring, and its holder shows a HOLD stamp. After the decision it returns to the rack and the stamp becomes APPROVED (green) or REJECTED (red).

### Approval gate card
A card whose head is neutral muted at rest and turns solid amber with a "HELD · YOUR DECISION" state readout while held, with the amber ring and raised shadow. Each step shows order, mono action type, tier badge, target, then the authority chain: three equal cells, Proposed by / Tier set by / Decided by, each filled with the colour of who holds it (muted "nobody" for forbidden). Dry runs sit in a mono muted well. Approve (solid green) and Reject (white with red border and text) sit at opposite ends, 24px apart minimum; both open a focus-trapped confirmation dialog.

### Tier badge
Pill, xs bold, 13px stroke SVG icon plus "Tier N" text plus tint: eye (1), check (2), warning triangle (3), crossed circle (4). Never colour alone.

### Forbidden block
Tier-4 and blocked reasons render as a dashed hatched block; the reason text sits on a white backing so it stays legible over the hatch.

### Numbers card
Card head carries a green "computed by code" chip. Each number is a provenance row: label left (muted), value right (650; key metrics 1.25rem 750), source line under it ("source: measured / assumption / derived"). Illustrative ranges are labelled as such. A closing provenance line states the model wrote none of the numbers.

### Buttons
- **Shape:** 8px corners, 40px minimum height, 8px 16px padding, 600 weight, optional 14px SVG icon.
- **Default:** white with slate border; hover darkens the border to ink; active nudges 1px down.
- **Primary (Step):** accent ink fill; hover adds the strip shadow.
- **Approve / Reject:** see the gate card. Confirm-reject in the dialog fills red.
- **Disabled:** muted fill, hairline border, muted text.

### Playback bar
Sticky bay-coloured bar: Step / Play / Pause buttons, an event counter with a 4px ink progress meter, and a status line that turns hold amber while held.

### Mode banner
Full-width night bar at the top of every screen with the pale-gold "Replay" tag; required on every screen.

## Do's and Don'ts

### Do:
- **Do** give every agent turn one strip with a solid authority holder that names the agent and its role.
- **Do** mark the held gate with transform offset, raised shadow, amber ring and a HOLD stamp, then restamp APPROVED or REJECTED.
- **Do** convey tier with text, icon and colour together.
- **Do** show every number with its source and under the "computed by code" chip.
- **Do** take every colour, space and type value from `tokens.css` and register new text/background pairs in `contrast-pairs.json`.
- **Do** disable animation and transition under `prefers-reduced-motion: reduce` (smooth scroll falls back to instant).

### Don't:
- **Don't** use grey status pills or a neutral timeline for agent events; who acted is the point.
- **Don't** spend an authority colour on decoration, headings or borders that do not denote who acted.
- **Don't** use raised elevation for anything not pulled out of the rack or modal.
- **Don't** let colour be the only carrier of tier, authority or status.
- **Don't** imply live execution: no screen without the replay banner.
