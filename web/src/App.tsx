// War Room in demo mode (spec 10.2; AC-39): the label is on every screen; pick a scenario, the recording replays event
// by event up to the gate, the decision picks the recorded branch and, at the end, the numbers and the post-mortem
// appear. A load error shows only the explicit message, with nothing partial from the recording.
import { useCallback, useEffect, useRef, useState } from "react";
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
import { AuthorityLegend } from "./components/AuthorityLegend.tsx";
import { ApprovalGate } from "./components/ApprovalGate.tsx";
import { MetricsCards } from "./components/MetricsCards.tsx";
import { PostmortemView } from "./components/PostmortemView.tsx";

/** Play mode interval (one event per step). */
export const PLAY_INTERVAL_MS = 700;

const STATUS_CLASS: Partial<Record<string, string>> = {
  awaiting_approval: "status-held",
  resolved: "status-resolved",
  escalated: "status-escalated",
};

export function App({ fetchImpl }: { fetchImpl?: typeof fetch }) {
  const [index, setIndex] = useState<LoadResult<ScenarioSummary[]> | null>(null);
  const [replay, setReplay] = useState<ReplayState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const stepRef = useRef<HTMLButtonElement>(null);
  const pauseRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLHeadingElement>(null);
  const requestRef = useRef(0);
  const returnToPicker = useRef(false);

  const fetchIndex = useCallback(() => {
    let alive = true;
    setIndex(null);
    void loadIndex(fetchImpl).then((r) => {
      if (alive) setIndex(r);
    });
    return () => {
      alive = false;
    };
  }, [fetchImpl]);

  useEffect(() => fetchIndex(), [fetchIndex]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setReplay((s) => (s ? step(s) : s)), PLAY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [playing]);

  useEffect(() => {
    if (replay && (replay.pausedAtGate || replay.finished)) setPlaying(false);
  }, [replay]);

  // Focus goes where the next action is. Play disables itself, so focus moves to Pause; pausing brings it back to
  // Step. A loaded recording or a chosen branch goes to Step; the gate and the end go to their panel titles; leaving a
  // replay returns to the picker heading.
  const loadedId = replay?.recording.scenario.id ?? null;
  const branch = replay?.branch ?? null;
  const atGate = replay?.pausedAtGate ?? false;
  const finished = replay?.finished ?? false;
  const wasPlaying = useRef(false);
  useEffect(() => {
    if (loadedId || branch) stepRef.current?.focus();
  }, [loadedId, branch]);
  useEffect(() => {
    if (playing) pauseRef.current?.focus();
    else if (wasPlaying.current && !atGate && !finished) stepRef.current?.focus();
    wasPlaying.current = playing;
  }, [playing, atGate, finished]);
  useEffect(() => {
    if (!atGate) return;
    // Focus the gate without jumping to it, then bring the held strip into view: the side column is sticky on wide
    // screens, so the held strip and the gate card share the viewport.
    document.getElementById("gate-title")?.focus({ preventScroll: true });
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wide = typeof window.matchMedia === "function" && window.matchMedia("(min-width: 960px)").matches;
    if (wide) document.querySelector(".strip.is-held")?.scrollIntoView?.({ block: "center", behavior: reduce ? "auto" : "smooth" });
    else document.getElementById("gate-title")?.scrollIntoView?.({ block: "start" });
  }, [atGate]);
  useEffect(() => {
    if (finished) document.getElementById("postmortem-title")?.focus();
  }, [finished]);
  useEffect(() => {
    if (!replay && returnToPicker.current && index?.ok) {
      returnToPicker.current = false;
      pickerRef.current?.focus();
    }
  }, [replay, index]);

  const select = async (id: string) => {
    const token = ++requestRef.current;
    setLoading(true);
    setLoadError(null);
    setReplay(null);
    setPlaying(false);
    const r = await loadRecording(id, fetchImpl);
    if (token !== requestRef.current) return; // a later click won
    setLoading(false);
    if (r.ok) setReplay(createReplay(r.value));
    else setLoadError(r.error);
  };

  const reset = () => {
    requestRef.current++;
    returnToPicker.current = true;
    setReplay(null);
    setPlaying(false);
    setLoading(false);
    setLoadError(null);
  };

  const snapshot = replay ? currentSnapshot(replay) : null;
  const atOrAfterGate = replay !== null && (replay.pausedAtGate || replay.branch !== null);
  const statusKnown = replay !== null && (replay.pausedAtGate || replay.finished);
  const status = snapshot && statusKnown ? snapshot.incident.incident.status : null;

  return (
    <div className="app">
      <header className="app-header">
        <ModeBanner />
        <div className="wrap masthead">
          <h1>War Room <span>· incident-copilot</span></h1>
          <p className="thesis">The model proposes; code and humans decide.</p>
        </div>
      </header>
      <main className="app-main wrap">
        {index && !index.ok ? (
          <div className="alert" role="alert">
            <p>{index.error}</p>
            <button type="button" className="btn" onClick={() => fetchIndex()}>Try again</button>
          </div>
        ) : null}
        {loadError ? <div className="alert" role="alert"><p>{loadError}</p></div> : null}
        {!replay ? (
          index?.ok ? (
            <ScenarioPicker scenarios={index.value} onSelect={(id) => void select(id)} headingRef={pickerRef} disabled={loading} />
          ) : index === null ? (
            <p className="muted">Loading scenarios…</p>
          ) : null
        ) : null}
        {loading ? <p className="muted">Loading recording…</p> : null}
        {replay && snapshot ? (
          <>
            <section className="incident-header" aria-labelledby="incident-title">
              <div className="incident-row">
                <h2 id="incident-title">{`${snapshot.incident.incident.id} · ${snapshot.incident.incident.title}`}</h2>
                <dl className="incident-meta">
                  <div>
                    <dt>Scenario</dt>
                    <dd>{replay.recording.scenario.id}</dd>
                  </div>
                  <div>
                    <dt>{replay.recording.scenario.service ? "Service" : "Account"}</dt>
                    <dd>{replay.recording.scenario.service ?? replay.recording.scenario.account}</dd>
                  </div>
                  <div>
                    <dt>Severity</dt>
                    <dd>{replay.recording.scenario.severity}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd className={status ? (STATUS_CLASS[status] ?? "") : ""}>{status ? INCIDENT_STATUS_LABELS[status] : "replaying"}</dd>
                  </div>
                </dl>
              </div>
              <div className="incident-row">
                <AuthorityLegend />
                <button type="button" className="link-button" onClick={reset}>Change scenario</button>
              </div>
            </section>
            <PlaybackControls
              state={replay}
              playing={playing}
              stepRef={stepRef}
              pauseRef={pauseRef}
              onStep={() => setReplay((s) => (s ? step(s) : s))}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
            />
            <div className={replay.pausedAtGate ? "layout is-held" : "layout"}>
              <AgentConversation events={visibleEvents(replay)} held={replay.pausedAtGate} decision={replay.branch} follow={playing} />
              <aside className="side" aria-label="Gate and numbers">
                {atOrAfterGate ? (
                  <ApprovalGate
                    actions={snapshot.incident.actions}
                    approvals={snapshot.approvals}
                    {...(replay.pausedAtGate ? { onDecide: (d: "approve" | "reject") => setReplay((s) => (s ? choose(s, d === "approve" ? "approved" : "rejected") : s)) } : {})}
                  />
                ) : (
                  <section className="card" aria-labelledby="gate-wait-title">
                    <div className="card-head">
                      <h2 id="gate-wait-title" className="card-title">Gate ahead</h2>
                    </div>
                    <div className="card-body">
                      <p className="gate-waiting">The catalog classifies every proposed action. Tier 3 stops here for a human; tier 4 never runs.</p>
                    </div>
                  </section>
                )}
                {replay.finished && snapshot.metrics ? <MetricsCards metrics={snapshot.metrics} /> : null}
              </aside>
            </div>
            {replay.finished && snapshot.postmortem ? <PostmortemView doc={snapshot.postmortem} /> : null}
          </>
        ) : null}
      </main>
      <footer className="app-footer">
        <div className="wrap">
          <p>Project-owned data, generated by the backend with a simulated clock. No real action is executed.</p>
        </div>
      </footer>
    </div>
  );
}
