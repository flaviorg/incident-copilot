# README media

| File | What it shows | Size |
|---|---|---|
| `docs/media/demo.gif` | About 26 seconds (29 frames) of the 0.2.0 War Room in the deploy scenario: scenario choice, agent strips arriving (blue for the model, green for code), the replay held at the gate with the gate strip slid out and its `HOLD` mark beside the approval card, the confirmation dialog, the `APPROVED` stamp and the amber human strip, the numbers (MTTR of 11.2 min, 3.0 min waiting for approval) and the post-mortem | 960 × 750 px, about 2.2 MB (target: up to 3 MB) |
| `docs/media/war-room.png` | The `cost-anomaly` scenario held at the gate, light theme: the held gate strip with `HOLD`, two tier 3 steps for a human, and the tier 4 `delete_backups` hatched and decided by nobody | 1280 × 900 px, about 170 KB (target: up to 500 KB) |
| `docs/media/war-room-dark.png` | The same view in the dark theme (the README swaps it in with `<picture>` and `prefers-color-scheme`) | 1280 × 900 px, about 170 KB |
| `docs/media/war-room-mobile.png` | The deploy scenario held at the gate on a 390 px phone: replay banner, incident header, playback bar and the gate card moved above the strip bay | 780 × 1688 px (390 × 844 at 2x), about 170 KB |

All four show the replay recorded with the fake provider. The label "Replay of a recorded run with a scripted fake provider" is on every screen; in the two gate screenshots the page is scrolled to the gate, so the banner is above the frame.

## How they were made

Re-recorded on 2026-11-20 for 0.2.0, from the War Room dev server (`npm run web:demo`, which re-records `web/public/demo` with `demo:record`):

1. A headless Chromium (Playwright's cached build, temporary profile deleted at the end) driven over the Chrome DevTools Protocol from a small Node script: light or dark theme, reduced motion.
2. **Screenshots:** 1280 × 900 viewport at 1.5x, cost scenario, Step up to the gate (the page brings the held strip into view on its own), the side column scrolled to the tier 4 step, then scaled to 1280 px and reduced to a 256-color palette with `ffmpeg`. The mobile shot is 390 × 844 at 2x, from the top of the page.
3. **GIF:** 1280 × 1000 viewport, one frame every two events, following the newest strip; frames held longer on the picker, the gate, the dialog, the numbers and the post-mortem. Built with the `ffmpeg` concat demuxer (per-frame durations), scaled to 960 px wide, 128-color palette with Bayer dithering.

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

4. **Screenshots.** In the cost scenario, Step up to the gate and capture the window (on macOS, Cmd+Shift+4 then Space). Save it as `docs/media/war-room.png`; repeat with the system in dark mode for `war-room-dark.png`, and at 390 px wide (responsive mode) for `war-room-mobile.png`.
5. Check the file sizes against the table above and run `npm run check:secrets`: the War Room recordings carry no secrets, but the check is cheap.

## What not to do

- Do not record the War Room with data from a real model and present it as the demo: the published demo is always the fake's replay.
- Do not edit the GIF to hide the demo mode label.

## After publishing

The README already points to the public repository `flaviorg/incident-copilot`: the CI badge uses `https://github.com/flaviorg/incident-copilot/actions/workflows/ci.yml/badge.svg?branch=main`, and the live demo is at `https://flaviorg.github.io/incident-copilot/`. The badge only turns green after the first push and the first passing CI run, and the Pages address only responds after the "Pages (War Room)" workflow is triggered by hand. If the War Room changes its look, re-record the GIF and the screenshot.
