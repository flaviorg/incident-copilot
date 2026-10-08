// Seleção de cenário (spec 10.2, item 1): um botão por cenário com título, serviço ou conta, severidade e resumo.
import type { ScenarioSummary } from "@contracts";

export function ScenarioPicker({ scenarios, onSelect }: { scenarios: ScenarioSummary[]; onSelect: (id: string) => void }) {
  return (
    <section className="panel" aria-labelledby="scenario-picker-title">
      <h2 id="scenario-picker-title">Escolha um cenário</h2>
      <ul className="scenario-list">
        {scenarios.map((s) => (
          <li key={s.id}>
            <button type="button" className="scenario-card" onClick={() => onSelect(s.id)}>
              <span className="scenario-title">{s.title}</span>
              <span className="scenario-meta">{`${s.service ? `serviço ${s.service}` : `conta ${s.account ?? "?"}`} · ${s.severity}`}</span>
              <span className="scenario-summary">{s.summary}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
