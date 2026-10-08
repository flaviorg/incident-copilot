// War Room em modo demo (spec 10.2; AC-39): o rótulo fica em todas as telas; escolhe-se um cenário, a gravação é
// reproduzida passo a passo até o portão, a decisão escolhe o ramo gravado e, no fim, aparecem os números e o
// post-mortem. Erro de carga mostra só a mensagem explícita, sem nada parcial da gravação.
import { useEffect, useRef, useState } from "react";
import type { ScenarioSummary } from "@contracts";
import { loadIndex, loadRecording } from "./data/demo-source.ts";
import type { LoadResult } from "./data/demo-source.ts";
import { choose, createReplay, currentSnapshot, step, visibleEvents } from "./replay/replay-engine.ts";
import type { ReplayState } from "./replay/replay-engine.ts";
import { INCIDENT_STATUS_LABELS } from "./labels.ts";
import { ModeBanner } from "./components/ModeBanner.tsx";
import { ScenarioPicker } from "./components/ScenarioPicker.tsx";
import { PlaybackControls } from "./components/PlaybackControls.tsx";
import { AgentConversation } from "./components/AgentConversation.tsx";
import { ApprovalGate } from "./components/ApprovalGate.tsx";
import { MetricsCards } from "./components/MetricsCards.tsx";
import { PostmortemView } from "./components/PostmortemView.tsx";

/** Intervalo do modo Reproduzir (um evento por passo). */
export const PLAY_INTERVAL_MS = 700;

export function App({ fetchImpl }: { fetchImpl?: typeof fetch }) {
  const [index, setIndex] = useState<LoadResult<ScenarioSummary[]> | null>(null);
  const [replay, setReplay] = useState<ReplayState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const stepRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    void loadIndex(fetchImpl).then((r) => {
      if (alive) setIndex(r);
    });
    return () => {
      alive = false;
    };
  }, [fetchImpl]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setReplay((s) => (s ? step(s) : s)), PLAY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [playing]);

  useEffect(() => {
    if (replay && (replay.pausedAtGate || replay.finished)) setPlaying(false);
  }, [replay]);

  // Foco onde está a próxima ação (o botão Avançar fica desabilitado no portão e no fim, e perderia o foco):
  // gravação carregada ou ramo escolhido vão para Avançar; o portão e o fim vão para o título do painel.
  const loadedId = replay?.recording.scenario.id ?? null;
  const branch = replay?.branch ?? null;
  const atGate = replay?.pausedAtGate ?? false;
  const finished = replay?.finished ?? false;
  useEffect(() => {
    if (loadedId || branch) stepRef.current?.focus();
  }, [loadedId, branch]);
  useEffect(() => {
    if (atGate) document.getElementById("gate-title")?.focus();
  }, [atGate]);
  useEffect(() => {
    if (finished) document.getElementById("postmortem-title")?.focus();
  }, [finished]);

  const select = async (id: string) => {
    setLoading(true);
    setLoadError(null);
    setReplay(null);
    setPlaying(false);
    const r = await loadRecording(id, fetchImpl);
    setLoading(false);
    if (r.ok) setReplay(createReplay(r.value));
    else setLoadError(r.error);
  };

  const reset = () => {
    setReplay(null);
    setPlaying(false);
    setLoadError(null);
  };

  const snapshot = replay ? currentSnapshot(replay) : null;
  const atOrAfterGate = replay !== null && (replay.pausedAtGate || replay.branch !== null);
  const statusKnown = replay !== null && (replay.pausedAtGate || replay.finished);

  return (
    <div className="app">
      <header className="app-header">
        <ModeBanner />
        <h1>War Room · incident-copilot</h1>
      </header>
      <main className="app-main">
        {index && !index.ok ? <div className="alert" role="alert">{index.error}</div> : null}
        {loadError ? <div className="alert" role="alert">{loadError}</div> : null}
        {!replay ? (
          index?.ok ? <ScenarioPicker scenarios={index.value} onSelect={(id) => void select(id)} /> : index === null ? <p className="muted">Carregando cenários…</p> : null
        ) : null}
        {loading ? <p className="muted">Carregando gravação…</p> : null}
        {replay && snapshot ? (
          <>
            <section className="panel incident-header" aria-labelledby="incident-title">
              <h2 id="incident-title">{`${snapshot.incident.incident.id} · ${snapshot.incident.incident.title}`}</h2>
              <dl className="incident-meta">
                <div>
                  <dt>Cenário</dt>
                  <dd>{replay.recording.scenario.id}</dd>
                </div>
                <div>
                  <dt>{replay.recording.scenario.service ? "Serviço" : "Conta"}</dt>
                  <dd>{replay.recording.scenario.service ?? replay.recording.scenario.account}</dd>
                </div>
                <div>
                  <dt>Severidade</dt>
                  <dd>{replay.recording.scenario.severity}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{statusKnown ? INCIDENT_STATUS_LABELS[snapshot.incident.incident.status] : "em reprodução"}</dd>
                </div>
              </dl>
              <button type="button" className="link-button" onClick={reset}>Trocar de cenário</button>
            </section>
            <PlaybackControls
              state={replay}
              playing={playing}
              stepRef={stepRef}
              onStep={() => setReplay((s) => (s ? step(s) : s))}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
            />
            <div className="layout">
              <AgentConversation events={visibleEvents(replay)} />
              <div className="side">
                {atOrAfterGate ? (
                  <ApprovalGate
                    actions={snapshot.incident.actions}
                    approvals={snapshot.approvals}
                    {...(replay.pausedAtGate ? { onDecide: (d: "approve" | "reject") => setReplay((s) => (s ? choose(s, d === "approve" ? "approved" : "rejected") : s)) } : {})}
                  />
                ) : null}
                {replay.finished && snapshot.metrics ? <MetricsCards metrics={snapshot.metrics} /> : null}
              </div>
            </div>
            {replay.finished && snapshot.postmortem ? <PostmortemView doc={snapshot.postmortem} /> : null}
          </>
        ) : null}
      </main>
      <footer className="app-footer muted">
        <p>Dados próprios do projeto, gerados pelo backend com relógio simulado. Nenhuma ação real é executada.</p>
      </footer>
    </div>
  );
}
