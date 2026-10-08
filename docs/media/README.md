# README media

| File | What it shows | Size |
|---|---|---|
| `docs/media/demo.gif` | About 16 seconds (27 frames) of the War Room in the deploy scenario: scenario choice, conversation between agents, approval gate, click on Approve, confirmation dialog and number cards (MTTR of 11.2 min and 3.0 min waiting for approval), with the interface in English | 960 × 1200 px, about 810 KB (target: up to 3 MB, 960 to 1280 px wide) |
| `docs/media/war-room.png` | The War Room stopped at the approval gate of the `cost-anomaly` scenario: three tier 3 steps awaiting a decision and the tier 4 `delete_backups` blocked without a dry run | 1280 × 1476 px, about 370 KB (target: up to 500 KB, 1280 px wide) |

Both show the replay recorded with the fake provider, and the label "Replay of a recorded run with a scripted fake provider" appears at the top of the page (in the last frames of the GIF the page scrolls down to the number cards).

## How they were made

Re-recorded on 2026-10-08, after the interface was translated to English, from the real War Room build (`npm run web:build`, which re-records `web/public/demo` with `demo:record`):

1. `web/dist` served on `127.0.0.1` by a local static server, with no external network.
2. A headless Chromium (temporary profile, deleted at the end), driven by Puppeteer: light theme, reduced motion, 1280 px viewport.
3. **Screenshot:** cost scenario, Step up to the gate, crop from the top of the page to the end of the gate panel.
4. **GIF:** 1280 × 1600 viewport (the demo mode label stays in frame until the final scroll to the numbers), one frame every two events, scaled down to 960 px wide. Script: "5xx rate above 5% in orders-api" card, Step up to the gate, Approve, Confirm, Step to the end and scroll to the number cards. The frames were turned into a GIF with `ffmpeg` (128-color palette), with per-frame timing (0.3 s per step; longer on the scenario choice, the gate, the dialog and the numbers).

The capture script is not part of the project, because it depends on the browser installed on the machine. Any manual recording that follows the script below works.

## How to re-record

1. Generate the recordings and start the War Room:

   ```bash
   npm run web:install   # first time only
   npm run web:demo
   ```

2. Open the address Vite prints (usually `http://localhost:5173`) in a 1280 px wide window. Use the light theme, which is what the README assumes.
3. **GIF.** Record the screen with any tool you like: on macOS, Cmd+Shift+5 records a `.mov`.
   - Script: click the "5xx rate above 5% in orders-api" card, Step up to the gate, click Approve, confirm in the dialog (Confirm) and Step up to the numbers.
   - Convert to GIF at 10 to 12 frames per second. For example, with `ffmpeg` installed:

     ```bash
     ffmpeg -i recording.mov -vf "fps=12,scale=1280:-1:flags=lanczos" -loop 0 docs/media/demo.gif
     ```

4. **Screenshot.** In the cost scenario, Step up to the gate and capture the window (on macOS, Cmd+Shift+4 then Space). Save it as `docs/media/war-room.png`.
5. Check both file sizes against the table above and run `npm run check:secrets`: the War Room recordings carry no secrets, but the check is cheap.

## What not to do

- Do not record the War Room with data from a real model and present it as the demo: the published demo is always the fake's replay.
- Do not edit the GIF to hide the demo mode label.

## After publishing

The README already points to the public repository `flaviorg/incident-copilot`: the CI badge uses `https://github.com/flaviorg/incident-copilot/actions/workflows/ci.yml/badge.svg?branch=main`, and the live demo is at `https://flaviorg.github.io/incident-copilot/`. The badge only turns green after the first push and the first passing CI run, and the Pages address only responds after the "Pages (War Room)" workflow is triggered by hand. If the War Room changes its look, re-record the GIF and the screenshot.
