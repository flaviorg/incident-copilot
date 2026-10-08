// Post-mortem estruturado (spec 10.2, item 6), com o selo que diz se a narrativa passou pelo guarda numérico.
import type { PostmortemDoc } from "@contracts";
import { ACTION_STATUS_LABELS, CATEGORY_LABELS, ESCALATION_LABELS, formatNumber, formatTime, formatUsd } from "../labels.ts";
import { TierBadge } from "./TierBadge.tsx";

export function PostmortemView({ doc }: { doc: PostmortemDoc }) {
  const validated = doc.numericGuard.passed && !doc.numericGuard.usedTemplate && doc.generatedBy.model !== "template";
  return (
    <section className="panel postmortem" aria-labelledby="postmortem-title">
      <h2 id="postmortem-title" tabIndex={-1}>{`Post-mortem ${doc.incidentId} (${doc.status === "final" ? "final" : "parcial"})`}</h2>
      <p className={validated ? "seal seal-ok" : "seal"}>{validated ? "narrativa validada pelo guarda numérico" : "narrativa do template"}</p>
      <h3>Resumo</h3>
      <p>{doc.summary}</p>
      <h3>Impacto</h3>
      <dl className="metrics-small">
        <div className="metric-row">
          <dt>Serviço</dt>
          <dd>{doc.impact.service}</dd>
        </div>
        <div className="metric-row">
          <dt>Duração</dt>
          <dd>{doc.impact.durationMin === null ? "sem resolução" : `${formatNumber(doc.impact.durationMin)} min`}</dd>
        </div>
        {doc.impact.peakErrorRate !== null ? (
          <div className="metric-row">
            <dt>Pico de erros</dt>
            <dd>{`${formatNumber(doc.impact.peakErrorRate * 100)}%`}</dd>
          </div>
        ) : null}
        {doc.impact.monthlySavingsUsd > 0 ? (
          <div className="metric-row">
            <dt>Economia por mês</dt>
            <dd>{formatUsd(doc.impact.monthlySavingsUsd)}</dd>
          </div>
        ) : null}
      </dl>
      <h3>Linha do tempo</h3>
      <ol className="timeline">
        {doc.timeline.map((t, i) => (
          <li key={`${t.ts}-${i}`}>
            <time dateTime={t.ts}>{formatTime(t.ts)}</time> {t.text}
          </li>
        ))}
      </ol>
      <h3>Causa raiz</h3>
      <p>{`${CATEGORY_LABELS[doc.rootCause.category]}: ${doc.rootCause.narrative}`}</p>
      {doc.rootCause.evidence.length > 0 ? (
        <ul>
          {doc.rootCause.evidence.map((e) => (
            <li key={e.ref}>
              <code>{e.ref}</code> {e.summary}
            </li>
          ))}
        </ul>
      ) : null}
      <h3>Ações</h3>
      <ul className="postmortem-actions">
        {doc.actions.map((a, i) => (
          <li key={`${a.actionType}-${i}`}>
            <code>{a.actionType}</code> <TierBadge tier={a.tier} /> {ACTION_STATUS_LABELS[a.status]}
            {a.decidedBy ? ` · decidido por ${a.decidedBy}` : ""}
          </li>
        ))}
      </ul>
      {doc.escalation ? (
        <>
          <h3>Escalonamento</h3>
          <p>{`${ESCALATION_LABELS[doc.escalation.reason]}: ${doc.escalation.detail}`}</p>
        </>
      ) : null}
      <h3>Prevenção</h3>
      <ul>
        {doc.prevention.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <p className="muted">{`Gerado por ${doc.generatedBy.provider} (${doc.generatedBy.model}, ${doc.generatedBy.promptVersion})`}</p>
    </section>
  );
}
