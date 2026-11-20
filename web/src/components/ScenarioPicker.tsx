// Scenario choice (spec 10.2, item 1): one strip-shaped button per scenario with title, service or account, severity and
// summary. The heading takes focus when the visitor comes back from a replay.
import type { ScenarioSummary } from "@contracts";
import type { Ref } from "react";
import { AuthorityLegend } from "./AuthorityLegend.tsx";

export function ScenarioPicker({ scenarios, onSelect, headingRef, disabled = false }: {
  scenarios: ScenarioSummary[];
  onSelect: (id: string) => void;
  headingRef?: Ref<HTMLHeadingElement>;
  disabled?: boolean;
}) {
  return (
    <section className="picker" aria-labelledby="scenario-picker-title">
      <div className="picker-intro">
        <h2 id="scenario-picker-title" ref={headingRef} tabIndex={-1}>Choose a scenario</h2>
        <p>
          Each run is replayed event by event. Agents investigate and propose; the catalog sets every action's tier; a
          tier 3 action stops at the gate until you decide. Watch the color of each strip.
        </p>
        <AuthorityLegend />
      </div>
      <ul className="scenario-list">
        {scenarios.map((s) => (
          <li key={s.id}>
            <button type="button" className="scenario-card" onClick={() => onSelect(s.id)} disabled={disabled}>
              <span className="scenario-sev" aria-hidden="true">
                {s.severity.toUpperCase()}
                <small>severity</small>
              </span>
              <span className="scenario-body">
                <span className="scenario-title">{s.title}</span>
                <span className="scenario-meta">{`${s.service ? `service ${s.service}` : `account ${s.account ?? "?"}`} · ${s.severity}`}</span>
                <span className="scenario-summary">{s.summary}</span>
                <span className="scenario-go">Replay this run</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
