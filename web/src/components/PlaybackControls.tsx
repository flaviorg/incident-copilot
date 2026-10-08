// Controles da reprodução (spec 10.2): passo a passo, reproduzir e pausar; nada começa sozinho ao carregar.
import type { ReplayState } from "../replay/replay-engine.ts";
import type { Ref } from "react";

export function PlaybackControls({ state, playing, onStep, onPlay, onPause, stepRef }: {
  state: ReplayState;
  playing: boolean;
  onStep: () => void;
  onPlay: () => void;
  onPause: () => void;
  stepRef?: Ref<HTMLButtonElement>;
}) {
  const { common, branches } = state.recording;
  const total = common.events.length + (state.branch && branches ? branches[state.branch].events.length : 0);
  const canStep = !state.pausedAtGate && !state.finished;
  const where = state.finished
    ? "reprodução concluída"
    : state.pausedAtGate
      ? "parado no portão de aprovação: decida para continuar"
      : playing
        ? "reproduzindo"
        : "pausado";
  return (
    <div className="playback" role="group" aria-label="Controles da reprodução">
      <div className="playback-buttons">
        <button type="button" ref={stepRef} onClick={onStep} disabled={!canStep || playing}>Avançar</button>
        <button type="button" onClick={onPlay} disabled={!canStep || playing}>Reproduzir</button>
        <button type="button" onClick={onPause} disabled={!playing}>Pausar</button>
      </div>
      <p className="playback-status" aria-live="polite">{`Evento ${state.cursor} de ${total} · ${where}`}</p>
    </div>
  );
}
