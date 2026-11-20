---
version: 1
slug: "web-src-app-tsx"
primary_target: "web/src/App.tsx"
related_targets: ["web/src"]
---

Scope: War Room (web/), the static replay of a recorded incident run. Mode: Operate.
Audience: evaluators with two minutes and SRE/on-call engineers, equally. Task: follow the run, decide at the gate, read the numbers and the post-mortem. Constraints: AC-39 (replay label on every screen, focus trap, tier by text+icon, 4.5:1 contrast, axe), tokens only in tokens.css, light and dark themes, English, no new deps.

## Direction contract

THESIS: The replay makes authority visible. Every event is a flight progress strip whose holder colour says who acted: model proposes (blue), code computes and enforces (green), a human decides (amber). Refuses the category default of a neutral timeline with grey status pills.

OWN-WORLD: Cool slate strip board (light) / deep slate board (dark); white strips with a solid coloured holder block carrying agent name and role; tabular figures; hatched dashed block for forbidden tier 4; amber "HOLD" mark on the pulled strip.

STORY: The visitor sees who did what, sees the model stopped at the gate by code, decides as the human, and reads numbers that code computed.

FIRST VIEWPORT: Replay banner on top; incident identity row (ID, title, service, severity, status); authority legend; playback bar; two columns: strip bay (left, ~62%) with newest at the bottom, side column with clearance card (action, target, proposed/tier set/decides chain, Approve/Reject) and numbers.

FORM: Flight progress strips, candidate 1 of my ordered list (Impeccable's pick, chosen by the user). seed:fbe624ca097ebc85. Signature move: the gate strip slides out of the bay (offset) while held and slides back stamped with the decision.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
