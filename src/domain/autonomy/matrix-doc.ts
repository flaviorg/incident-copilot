// Gera docs/autonomy-matrix.md a partir do catálogo (spec 6.4 e 7.6). Puro. O teste docs-matrix compara o arquivo
// versionado com esta saída, então a documentação não diverge do código.
import { ReadToolNameSchema } from "../../contracts/index.ts";
import { EXECUTABLE_ACTIONS, EXECUTABLE_ACTION_TYPES, FORBIDDEN_ACTIONS, REASONS } from "./catalog.ts";

const yesNo = (b: boolean) => (b ? "yes" : "no");
const code = (s: string) => `\`${s}\``;

export function renderAutonomyMatrix(): string {
  const byTier = (tier: 2 | 3) => EXECUTABLE_ACTION_TYPES.filter((t) => EXECUTABLE_ACTIONS[t].tier === tier);
  const actionRows = (tier: 2 | 3) =>
    byTier(tier).map((t) => {
      const a = EXECUTABLE_ACTIONS[t];
      return `| ${tier} | ${code(t)} | ${code(a.targetPattern)} | ${code(a.paramsText)} | ${yesNo(a.mitigates)} | ${yesNo(a.reversible)} | ${a.durationSec} s |`;
    });
  const lines = [
    "# Autonomy Matrix",
    "",
    "> File generated from `src/domain/autonomy/catalog.ts` by `node scripts/gen-autonomy-doc.ts` (also runs in `npm run regen`). Do not edit by hand: the `docs-matrix.unit.test.ts` test fails if this file diverges from the catalog.",
    "",
    "The tier of each step comes from the catalog and from context rules that only raise the tier, never lower it. The model output has no tier field.",
    "",
    "## Tiers",
    "",
    "| Tier | Rule | What belongs here |",
    "|---|---|---|",
    `| Tier 1: decides alone | Read-only, zero risk | Tools ${ReadToolNameSchema.options.map(code).join(", ")} |`,
    `| Tier 2: decides and records | Reversible change or no effect on the service, with audit | ${byTier(2).map(code).join(", ")} |`,
    `| Tier 3: requires human approval | Destructive or high impact | ${byTier(3).map(code).join(", ")} |`,
    `| Tier 4: forbidden by construction | Exposing data, deleting audit or backup, disabling controls | ${FORBIDDEN_ACTIONS.map(code).join(", ")} and any type not in the catalog (deny by default) |`,
    "",
    "## Executable action catalog",
    "",
    "| Tier | Type | Target | Parameters | Mitigates | Reversible | Simulated duration |",
    "|---|---|---|---|---|---|---|",
    ...actionRows(2),
    ...actionRows(3),
    "",
    "Parameters outside the catalog schema move the step to `rejected_invalid_params`, without a dry run.",
    "",
    "## Context rules (raise to tier 3)",
    "",
    `- ${REASONS.outOfScope}: the target is neither the incident itself nor owned by the incident service or account (blast radius).`,
    `- ${REASONS.noRunbook}: the step does not cite a runbook passage (null \`runbookRef\`).`,
    `- ${REASONS.revisionsExhausted}: the plan reached the remediation gate with the auditor revisions exhausted and a final \`revise\` verdict.`,
    "",
    "## Tier 4 by construction",
    "",
    "1. The executor registry is typed by `ExecutableActionType`, and the forbidden types do not belong to it: no code exists that executes them.",
    "2. `classifyAction` returns tier 4 for forbidden and unknown types, and the remediation gate blocks them without a dry run and without an approval queue.",
    "3. The `audit_log` table has triggers that abort `UPDATE` and `DELETE`, and the store has no delete method.",
    "",
  ];
  return lines.join("\n");
}
