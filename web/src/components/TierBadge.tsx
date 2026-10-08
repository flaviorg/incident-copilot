// Selo de faixa da Matriz de Autonomia (spec 6.4; AC-39): texto "Faixa N", ícone decorativo e cor; nunca só a cor.
import type { ReactNode } from "react";
import type { Tier } from "@contracts";
import { TIER_LABELS } from "../labels.ts";

const ICONS: Record<Tier, ReactNode> = {
  1: (
    <>
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  2: <path d="M3 8.5l3 3 7-7" />,
  3: (
    <>
      <path d="M8 2l6.5 11.5h-13z" />
      <path d="M8 6.5v3.2M8 11.8v.4" />
    </>
  ),
  4: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M3.8 12.2l8.4-8.4" />
    </>
  ),
};

export function TierBadge({ tier }: { tier: Tier }) {
  return (
    <span className={`tier-badge tier-${tier}`} title={`Faixa ${tier}: ${TIER_LABELS[tier]}`}>
      <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {ICONS[tier]}
      </svg>
      <span>{`Faixa ${tier}`}</span>
    </span>
  );
}
