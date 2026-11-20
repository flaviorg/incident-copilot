// Replay controls (spec 10.2): step, play and pause; nothing starts on its own. The live region announces only state
// changes (playing, paused, at the gate, finished), never the counter, so screen readers are not flooded during Play.
import type { Ref } from "react";
import type { ReplayState } from "../replay/replay-engine.ts";

export function PlaybackControls({ state, playing, onStep, onPlay, onPause, stepRef, playRef, pauseRef }: {
  state: ReplayState;
  playing: boolean;
  onStep: () => void;
  onPlay: () => void;
  onPause: () => void;
  stepRef?: Ref<HTMLButtonElement>;
  playRef?: Ref<HTMLButtonElement>;
  pauseRef?: Ref<HTMLButtonElement>;
}) {
  const { common, branches } = state.recording;
  const branchTotal = state.branch && branches ? branches[state.branch].events.length : 0;
  const total = common.events.length + branchTotal;
  const canStep = !state.pausedAtGate && !state.finished;
  const where = state.finished
    ? "Replay finished"
    : state.pausedAtGate
      ? "Held at the approval gate: your decision"
      : playing
        ? "Playing"
        : "Paused";
  const pct = total === 0 ? 0 : Math.round((state.cursor / total) * 100);
  return (
    <div className="playback" role="group" aria-label="Replay controls">
      <div className="playback-buttons">
        <button type="button" className="btn-step" ref={stepRef} onClick={onStep} disabled={!canStep || playing}>
          <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M3 2.5v11l7-5.5zM11 2.5h2v11h-2z" /></svg>
          Step
        </button>
        <button type="button" ref={playRef} onClick={onPlay} disabled={!canStep || playing}>
          <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M4 2.5v11L13 8z" /></svg>
          Play
        </button>
        <button type="button" ref={pauseRef} onClick={onPause} disabled={!playing}>
          <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" /></svg>
          Pause
        </button>
      </div>
      <div className="playback-progress">
        <p className="playback-count">
          Event <b>{state.cursor}</b> of <b>{total}</b>
          {state.branch === null && branches !== null && !state.pausedAtGate ? " before the gate" : ""}
        </p>
        <div className="playback-meter" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>
      <p className={state.pausedAtGate ? "playback-status is-held" : "playback-status"} aria-live="polite">{where}</p>
    </div>
  );
}
