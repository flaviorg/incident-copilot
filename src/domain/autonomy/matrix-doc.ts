// Gera docs/autonomy-matrix.md a partir do catálogo (spec 6.4 e 7.6). Puro. O teste docs-matrix compara o arquivo
// versionado com esta saída, então a documentação não diverge do código.
import { ReadToolNameSchema } from "../../contracts/index.ts";
import { EXECUTABLE_ACTIONS, EXECUTABLE_ACTION_TYPES, FORBIDDEN_ACTIONS, REASONS } from "./catalog.ts";

const yesNo = (b: boolean) => (b ? "sim" : "não");
const code = (s: string) => `\`${s}\``;

export function renderAutonomyMatrix(): string {
  const byTier = (tier: 2 | 3) => EXECUTABLE_ACTION_TYPES.filter((t) => EXECUTABLE_ACTIONS[t].tier === tier);
  const actionRows = (tier: 2 | 3) =>
    byTier(tier).map((t) => {
      const a = EXECUTABLE_ACTIONS[t];
      return `| ${tier} | ${code(t)} | ${code(a.targetPattern)} | ${code(a.paramsText)} | ${yesNo(a.mitigates)} | ${yesNo(a.reversible)} | ${a.durationSec} s |`;
    });
  const lines = [
    "# Matriz de Autonomia",
    "",
    "> Arquivo gerado a partir de `src/domain/autonomy/catalog.ts` por `node scripts/gen-autonomy-doc.ts` (também roda em `npm run regen`). Não edite à mão: o teste `docs-matrix.unit.test.ts` falha se este arquivo divergir do catálogo.",
    "",
    "A faixa de cada passo vem do catálogo e de regras de contexto que só sobem a faixa, nunca descem. A saída do modelo não tem campo de faixa.",
    "",
    "## Faixas",
    "",
    "| Faixa | Regra | O que entra |",
    "|---|---|---|",
    `| Faixa 1: decide sozinho | Leitura, risco zero | Ferramentas ${ReadToolNameSchema.options.map(code).join(", ")} |`,
    `| Faixa 2: decide e registra | Mudança reversível ou sem efeito no serviço, com auditoria | ${byTier(2).map(code).join(", ")} |`,
    `| Faixa 3: exige aprovação humana | Destrutivo ou alto impacto | ${byTier(3).map(code).join(", ")} |`,
    `| Faixa 4: proibido por construção | Expor dados, apagar auditoria ou backup, desligar controle | ${FORBIDDEN_ACTIONS.map(code).join(", ")} e qualquer tipo fora do catálogo (negar por padrão) |`,
    "",
    "## Catálogo de ações executáveis",
    "",
    "| Faixa | Tipo | Alvo | Parâmetros | Mitiga | Reversível | Duração simulada |",
    "|---|---|---|---|---|---|---|",
    ...actionRows(2),
    ...actionRows(3),
    "",
    "Parâmetros fora do schema do catálogo levam o passo a `rejected_invalid_params`, sem dry run.",
    "",
    "## Regras de contexto (sobem para faixa 3)",
    "",
    `- ${REASONS.outOfScope}: o alvo não é o próprio incidente nem pertence ao serviço ou à conta do incidente (raio de impacto).`,
    `- ${REASONS.noRunbook}: o passo não cita um trecho de runbook (\`runbookRef\` nulo).`,
    `- ${REASONS.revisionsExhausted}: o plano chegou ao portão com as revisões do auditor esgotadas e veredito final \`revise\`.`,
    "",
    "## Faixa 4 por construção",
    "",
    "1. O registro de executores é tipado por `ExecutableActionType`, e os tipos proibidos não pertencem a ele: não existe código que os execute.",
    "2. `classifyAction` devolve faixa 4 para proibidos e desconhecidos, e o portão bloqueia sem dry run e sem fila de aprovação.",
    "3. A tabela `audit_log` tem gatilhos que abortam `UPDATE` e `DELETE`, e o store não tem método de remoção.",
    "",
  ];
  return lines.join("\n");
}
