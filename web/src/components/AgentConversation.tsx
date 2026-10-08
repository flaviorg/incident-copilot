// Conversa entre agentes (spec 10.2, item 3): mensagens agrupadas por agente, passagens como "Supervisor para Analista
// de telemetria: ...", e pensamentos, ações e observações recolhíveis.
import type { TraceEvent } from "@contracts";
import { AGENT_NAMES, ANSWER_LABELS, CRITIC_LABELS, TRACE_TYPE_LABELS, VERDICT_LABELS, formatTime } from "../labels.ts";
import { TierBadge } from "./TierBadge.tsx";

type Group = { agent: TraceEvent["agent"]; events: TraceEvent[] };

function groupByAgent(events: TraceEvent[]): Group[] {
  const groups: Group[] = [];
  for (const e of events) {
    const last = groups.at(-1);
    if (last && last.agent === e.agent) last.events.push(e);
    else groups.push({ agent: e.agent, events: [e] });
  }
  return groups;
}

function EventItem({ e }: { e: TraceEvent }) {
  const time = <time dateTime={e.ts} className="event-time">{formatTime(e.ts)}</time>;
  switch (e.type) {
    case "handoff":
      return (
        <p className="event handoff">
          {time}
          <span>{`${AGENT_NAMES[e.payload.from]} to ${AGENT_NAMES[e.payload.to]}: ${e.payload.brief}`}</span>
        </p>
      );
    case "thought":
      return (
        <details className="event">
          <summary>{time} {TRACE_TYPE_LABELS.thought}</summary>
          <p>{e.payload.text}</p>
        </details>
      );
    case "action":
      return (
        <details className="event">
          <summary>
            {time} {`${TRACE_TYPE_LABELS.action}: ${e.payload.tool}`} {e.payload.tier !== null ? <TierBadge tier={e.payload.tier} /> : null}
          </summary>
          <pre>{JSON.stringify(e.payload.args, null, 2)}</pre>
        </details>
      );
    case "observation":
      return (
        <details className="event">
          <summary>{time} {`${TRACE_TYPE_LABELS.observation}: ${e.payload.tool} (${e.payload.ok ? "ok" : "not completed"})`}</summary>
          <p>{e.payload.summary}</p>
        </details>
      );
    case "plan":
      return (
        <details className="event">
          <summary>{time} {`${TRACE_TYPE_LABELS.plan} (revision ${e.payload.revision}, ${e.payload.steps.length} steps)`}</summary>
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
          {time}
          <span>{`${TRACE_TYPE_LABELS.critique} (${CRITIC_LABELS[e.payload.by]}, ${VERDICT_LABELS[e.payload.verdict]}): ${e.payload.feedback}`}</span>
        </p>
      );
    case "answer":
      return (
        <details className="event" open={e.payload.kind !== "postmortem"}>
          <summary>{time} {ANSWER_LABELS[e.payload.kind]}</summary>
          <p>{e.payload.text}</p>
        </details>
      );
  }
}

export function AgentConversation({ events }: { events: TraceEvent[] }) {
  return (
    <section className="panel" aria-labelledby="conversation-title">
      <h2 id="conversation-title">Agent conversation</h2>
      {events.length === 0 ? (
        <p className="muted">No events yet. Use Step or Play.</p>
      ) : (
        <ol className="conversation">
          {groupByAgent(events).map((g) => (
            <li key={g.events[0]!.id} className="agent-group">
              <h3 className="agent-name">{AGENT_NAMES[g.agent]}</h3>
              <ol className="agent-messages">
                {g.events.map((e) => (
                  <li key={e.id}>
                    <EventItem e={e} />
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
