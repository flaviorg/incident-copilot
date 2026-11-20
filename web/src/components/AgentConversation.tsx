// Agent conversation as a strip bay (spec 10.2, item 3): one flight strip per event, newest at the bottom. The holder
// colour and role line say who acted (model, code or human); handoffs read "Supervisor to Telemetry analyst: ...";
// thoughts, actions and observations fold. While the replay is held at the gate, the gate strip slides out of the bay
// and comes back stamped with the decision.
import { useEffect, useRef } from "react";
import type { TraceEvent } from "@contracts";
import { AGENT_NAMES, AGENT_ROLES, ANSWER_LABELS, CRITIC_LABELS, TRACE_TYPE_LABELS, VERDICT_LABELS, authorityOf, formatTime } from "../labels.ts";
import type { Branch } from "../replay/replay-engine.ts";
import { TierBadge } from "./TierBadge.tsx";

function EventBody({ e }: { e: TraceEvent }) {
  switch (e.type) {
    case "handoff":
      return (
        <p className="event handoff">
          <span>{`${AGENT_NAMES[e.payload.from]} to ${AGENT_NAMES[e.payload.to]}: ${e.payload.brief}`}</span>
        </p>
      );
    case "thought":
      return (
        <details className="event">
          <summary><span className="event-kind">{TRACE_TYPE_LABELS.thought}</span></summary>
          <p>{e.payload.text}</p>
        </details>
      );
    case "action":
      return (
        <details className="event">
          <summary>
            <span className="event-kind">{`${TRACE_TYPE_LABELS.action}: ${e.payload.tool}`}</span>
            {e.payload.tier !== null ? <TierBadge tier={e.payload.tier} /> : null}
          </summary>
          <pre>{JSON.stringify(e.payload.args, null, 2)}</pre>
        </details>
      );
    case "observation":
      return (
        <details className="event">
          <summary>
            <span className="event-kind">{`${TRACE_TYPE_LABELS.observation}: ${e.payload.tool}`}</span>
            <span className={e.payload.ok ? "event-ok" : "event-fail"}>{e.payload.ok ? "ok" : "not completed"}</span>
          </summary>
          <p>{e.payload.summary}</p>
        </details>
      );
    case "plan":
      return (
        <details className="event">
          <summary><span className="event-kind">{`${TRACE_TYPE_LABELS.plan} (revision ${e.payload.revision}, ${e.payload.steps.length} steps)`}</span></summary>
          <p>{e.payload.summary}</p>
          <ol>
            {e.payload.steps.map((s) => (
              <li key={s.order}>{`${s.actionType} on ${s.target}`}</li>
            ))}
          </ol>
        </details>
      );
    case "critique":
      return (
        <p className="event critique">
          <span>{`${TRACE_TYPE_LABELS.critique} (${CRITIC_LABELS[e.payload.by]}, ${VERDICT_LABELS[e.payload.verdict]}): ${e.payload.feedback}`}</span>
        </p>
      );
    case "answer":
      return (
        <details className="event" open={e.payload.kind !== "postmortem"}>
          <summary><span className="event-kind">{ANSWER_LABELS[e.payload.kind]}</span></summary>
          <p>{e.payload.text}</p>
        </details>
      );
  }
}

function Stamp({ held, decision }: { held: boolean; decision: Branch | null }) {
  if (held) return <span className="stamp stamp-hold">HOLD</span>;
  if (decision === "approved") return <span className="stamp stamp-approved">APPROVED</span>;
  if (decision === "rejected") return <span className="stamp stamp-rejected">REJECTED</span>;
  return null;
}

type Turn = { agent: TraceEvent["agent"]; events: TraceEvent[] };

/** Consecutive events from the same agent share one strip: one strip per turn. */
function toTurns(events: TraceEvent[]): Turn[] {
  const turns: Turn[] = [];
  for (const e of events) {
    const last = turns.at(-1);
    if (last && last.agent === e.agent) last.events.push(e);
    else turns.push({ agent: e.agent, events: [e] });
  }
  return turns;
}

export function AgentConversation({ events, held = false, decision = null, follow = false }: {
  events: TraceEvent[];
  /** The replay is stopped at the approval gate. */
  held?: boolean;
  /** Branch chosen at the gate, if any. */
  decision?: Branch | null;
  /** Keep the newest strip in view (while playing). */
  follow?: boolean;
}) {
  const lastRef = useRef<HTMLLIElement>(null);
  const turns = toTurns(events);
  let gateTurn = -1;
  turns.forEach((t, i) => {
    if (t.agent === "gate") gateTurn = i;
  });

  useEffect(() => {
    if (!follow) return;
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    lastRef.current?.scrollIntoView?.({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [events.length, follow]);

  return (
    <section className="bay" aria-labelledby="conversation-title">
      <div className="bay-head">
        <h2 id="conversation-title">Agent conversation</h2>
        <p>{events.length === 0 ? "Strip bay, newest at the bottom" : `${turns.length} turns, ${events.length} events, newest at the bottom`}</p>
      </div>
      {events.length === 0 ? (
        <p className="bay-empty">No events yet. Use Step or Play to bring in the first strip.</p>
      ) : (
        <ol className="strips">
          {turns.map((t, i) => {
            const authority = authorityOf(t.events[0]!);
            const isGate = i === gateTurn && (held || decision !== null);
            const classes = ["strip", isGate ? "is-gate" : "", isGate && held ? "is-held" : ""].filter(Boolean).join(" ");
            return (
              <li key={t.events[0]!.id} className={classes} ref={i === turns.length - 1 ? lastRef : undefined}>
                <div className={`strip-holder auth-${authority}`}>
                  <h3 className="agent-name">{AGENT_NAMES[t.agent]}</h3>
                  <small>{AGENT_ROLES[t.agent]}</small>
                  {isGate ? <Stamp held={held} decision={decision} /> : null}
                </div>
                <ol className="turn">
                  {t.events.map((e) => (
                    <li key={e.id} className="strip-body">
                      <time dateTime={e.ts} className="event-time">{formatTime(e.ts)}</time>
                      <EventBody e={e} />
                    </li>
                  ))}
                </ol>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
