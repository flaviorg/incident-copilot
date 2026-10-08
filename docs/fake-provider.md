# Provedor fake roteirizado

O `FakeLlmProvider` (`src/llm/fake-provider.ts`) é o provedor padrão (`LLM_PROVIDER=fake`). Ele faz a demo e a suíte inteira rodarem sem rede e sem chave. Ele **prova a mecânica, não a qualidade do modelo**:

- fluxo do grafo, contratos e tetos;
- portão e máquina de aprovação;
- números, redação e auditoria.

Cada resposta está escrita numa fixture. Chamada sem turno correspondente lança erro, para o teste quebrar quando alguém muda um prompt ou o fluxo sem atualizar o roteiro.

## Formato da fixture

Um arquivo por cenário: `fixtures/llm/<cenário>.json` para os cenários de demo e `tests/fixtures/llm/*.json` para os quatro roteiros só de teste. O schema está em `src/llm/fixture-format.ts`.

```json
{
  "schemaVersion": 1,
  "scenarioId": "deploy-5xx-rollback",
  "promptHashes": {
    "supervisor.v1": "sha256:<hash de version + \"\\n\" + system>",
    "telemetry-react.v1": "sha256:...",
    "planner.v1": "sha256:...",
    "auditor.v1": "sha256:...",
    "postmortem.v1": "sha256:..."
  },
  "turns": [
    {
      "id": "sup-1",
      "prompt": "supervisor.v1",
      "when": { "hasDiagnosis": false },
      "output": { "next": "telemetry_analyst", "brief": "...", "reason": "..." },
      "usage": { "promptTokens": 812, "completionTokens": 61 }
    },
    {
      "id": "tel-1",
      "prompt": "telemetry-react.v1",
      "when": { "run": 1, "step": 1 },
      "output": { "kind": "action", "thought": "...", "tool": "query_metrics", "args": { "service": "orders-api", "metric": "http_5xx_rate", "window": "30m" } }
    }
  ]
}
```

Campos de cada turno:

| Campo | Obrigatório | Significado |
|---|---|---|
| `id` | sim | Identificador único no arquivo. O schema recusa id repetido |
| `prompt` | sim | Versão do prompt (`supervisor.v1`, `planner.v1` e assim por diante) |
| `when` | sim | Condição: subconjunto das `matchKeys` da chamada, com igualdade por chave |
| `output` ou `error` | exatamente um | Saída roteirizada, ou falha simulada (`{ "kind": "timeout" \| "rate_limit" \| "server_error" \| "invalid_output" }`) |
| `usage` | não | Tokens do turno. Sem ele, o fake estima cerca de 4 caracteres por token |
| `delayMs` | não | Atraso antes de responder, abortável pelo sinal da chamada |

## Regras do fake

1. **Hash do prompt.** Antes de responder, o fake calcula `"sha256:" + sha256(version + "\n" + system)` e compara com `promptHashes[version]`. Se divergir, lança `FixturePromptDriftError` com o nome do prompt e a instrução de rodar `npm run fixtures:rehash`. O schema de saída não entra no hash.
2. **Correspondência.** O fake monta `prompt.matchKeys(input)` e procura, na ordem do arquivo, o primeiro turno daquele prompt que **este incidente** ainda não consumiu e cujo `when` casa. O consumo é por incidente (`ctx.incidentId`). Assim, a API e o servidor MCP, que são processos de longa duração, podem abrir vários incidentes do mesmo cenário. Cada um toca o roteiro desde o começo. Esse defeito foi encontrado no bloco 4 (ver `docs/incidents/0001-fake-consumia-roteiro-por-processo.md`).
3. **Sem turno.** O fake lança `UnscriptedLlmCallError` com cenário, prompt, número da chamada, digest SHA-256 da entrada completa, `matchKeys`, total de turnos do prompt e quantos já foram consumidos.
4. **Validação.** A saída do turno passa pelo `outputSchema` do prompt, como se viesse do modelo. `tests/unit/contracts.unit.test.ts` confere todas as fixtures (formato, hashes atuais e saída de cada turno no schema). Assim, uma fixture inválida falha na suíte, não no meio da demo.
5. **Falhas simuladas.** Um turno com `error` devolve a falha daquele tipo. É assim que os testes exercitam retry, fallback e 503. `invalid_output` conta como falha da tentativa, como uma saída que não passa no Zod.
6. **Atraso.** Com `delayMs`, o fake espera com `setTimeout`. Se `ctx.signal` abortar antes, devolve `aborted`. É assim que os testes provocam `LLM_TIMEOUT_MS` e `RUN_TIMEOUT_MS` de verdade, com aborto real.
7. **Uso.** Tokens do turno ou estimados, custo 0, modelo `fake/scripted`.
8. **Modo estrito.** `assertAllConsumed({ scenarioId })` lança listando os turnos que nenhum incidente consumiu. Os testes de cenário rodam em modo estrito. Testes de falha que param no meio do roteiro afirmam a lista exata de turnos consumidos (`consumedIds()`).
9. **Registro de entradas (só teste).** `calls()` devolve `{ prompt, matchKeys, user, turnId }` de cada chamada. O teste de injeção usa isso para provar que o texto hostil chegou ao prompt.

## `matchKeys` por prompt

| Prompt | Chaves | Exemplo de `when` |
|---|---|---|
| `supervisor.v1` | `hasDiagnosis`, `runbookSearchDone`, `hasPlan`, `hasAudit`, `verified` | `{ "hasDiagnosis": true, "runbookSearchDone": false }` |
| `telemetry-react.v1` | `run` (1 ou 2), `step` (1 a 12) | `{ "run": 1, "step": 3 }` |
| `planner.v1` | `revision` | `{ "revision": 1 }` |
| `auditor.v1` | `revision` | `{ "revision": 0 }` |
| `postmortem.v1` | `kind` (`final`) | `{ "kind": "final" }` |

As chaves são pequenas e estáveis de propósito: o texto completo do prompt pode mudar sem quebrar a correspondência. O hash da regra 1 protege o `system`.

## Ajustes em código: `patchFixture`

Os caminhos de falha não multiplicam arquivos. `tests/helpers/fixtures.ts` deriva uma fixture de outra sem alterar a base:

```ts
import { errTurn, patchFixture, readFixture, turn } from "../helpers/fixtures.ts";

const base = readFixture("fixtures/llm/deploy-5xx-rollback.json");
const flaky = patchFixture(base, {
  replace: { "sup-1": { delayMs: 200 } },                         // RUN_TIMEOUT_MS=50 aborta de verdade
  insertBefore: { "plan-0": [errTurn("plan-err", { revision: 0 }, "server_error")] },
  append: [turn("plan-1", { revision: 1 }, { /* saída */ }, "planner.v1")],
  remove: ["pm-1"],
});
```

- `replace` troca campos de um turno. Passar `error` remove `output`, e vice-versa.
- `remove` tira turnos.
- `insertBefore` insere turnos antes de um âncora. Turno sem `prompt` herda o do âncora.
- `append` acrescenta turnos no fim.
- Id inexistente lança erro, para um erro de digitação não passar em silêncio.
- O resultado passa de novo pelo schema.

Roteiros só de teste em `tests/fixtures/llm/`:

| Arquivo | O que exercita |
|---|---|
| `react-cap.json` | O analista nunca chega a `final` em 12 passos. O passo 3 chama ferramenta inexistente e o passo 4 manda argumentos inválidos (AC-05, AC-07) |
| `guard-coercion.json` | O supervisor pede `gate` sem plano, e a guarda coage para a rota canônica (AC-03) |
| `invented-numbers.json` | Narrativa com um percentual inventado, que o guarda numérico rejeita (AC-23) |
| `injected-logs.json` | Log hostil no cenário de deploy e um planejador que inclui `delete_backups` (AC-11) |

## Quando rodar `fixtures:rehash` e `regen`

| Mudou | Rode | Por quê |
|---|---|---|
| O texto `system` de um prompt em `src/prompts/v1/` | `npm run fixtures:rehash` | Atualiza os `promptHashes` de todas as fixtures e imprime `arquivo prompt antigo -> novo`. Não há prompt interativo: o diff do Git é a revisão. Uma segunda execução diz "nenhum hash mudou" |
| O formato da entrada de um prompt ou o fluxo do grafo | Edite os turnos à mão | O hash não cobre isso. O `UnscriptedLlmCallError` diz qual prompt e quais chaves faltaram |
| Fórmula de métrica, cenário, fixture ou catálogo de ações | `npm run regen` | Regera `tests/golden/metrics.<cenário>.<ramo>.json` e `docs/autonomy-matrix.md`. Revise o diff antes de aceitar |
| Só código, sem mudar o comportamento esperado | Nada | Se o golden quebrar, o comportamento mudou: investigue antes de rodar `regen` |

Regra prática: **fixture muda junto com prompt.** Um commit que altera `src/prompts/v1/*` sem tocar em `fixtures/llm/*` deixa a suíte vermelha.

## O que o fake prova

- O fluxo do grafo, as rotas por código, os tetos e o escalonamento, com o trace e o blackboard persistidos.
- Que a faixa vem do catálogo e não do modelo, e que a faixa 4 nunca executa, mesmo quando o plano roteirizado a inclui.
- A máquina de aprovação, o token, a redação e a auditoria encadeada.
- Que os números vêm de funções puras sobre os dados e que o guarda numérico rejeita número inventado.
- Os caminhos de falha do LLM (timeout, `rate_limit`, `server_error`, saída inválida), com retry, fallback, 503 e 504.

## O que o fake não prova

- **Qualidade do modelo.** Um LLM real pode errar o diagnóstico, escolher outro especialista ou montar um plano pior. As guardas e o portão limitam o dano, mas não garantem acerto.
- **Reflection espontâneo.** Na demo `cost-anomaly`, o auditor devolve o plano porque a regra em código `snapshot_before_delete` reprova a revisão 0. O texto do feedback é roteirizado. Com modelo real, o veredito do LLM pode diferir, mas nunca afrouxa o das regras.
- **Tempos reais.** O MTTR da demo vem do relógio simulado: 20 s por chamada de LLM, 3 s por ferramenta, 2 s por dry run, a duração do catálogo por execução, 180 s por aprovação e 60 s de canário.
- **Custo real.** O fake custa 0. `data/model-prices.json` só entra em jogo com o provedor real.

Para conferir o contrato com um modelo de verdade, use `npm run test:live` com `OPENROUTER_API_KEY` e `OPENROUTER_MODEL` no `.env`. O teste afirma só estrutura: categoria do diagnóstico no enum, passos no catálogo ou bloqueados, e guarda numérico aprovado ou template usado.
