# 002: Agente único

Marco M2. Estado: implementado.

## Contexto

Antes da equipe, um agente sozinho precisa investigar de forma confiável: o analista de telemetria em laço ReAct sobre as ferramentas de leitura da spec 001. Este marco também fixa o contrato com o LLM:

- prompts versionados;
- saída estruturada validada por Zod;
- retry, fallback e timeout;
- o provedor fake roteirizado, que faz a suíte e a demo rodarem sem rede.

## Escopo

- `LlmProvider`, com dois provedores:
  - `FakeLlmProvider`: hash do prompt, correspondência por `matchKeys`, erro com diagnóstico, falhas simuladas, `delayMs` abortável, modo estrito e registro de entradas;
  - `OpenRouterProvider`: `ChatOpenAI` com `baseURL` e `withStructuredOutput`.
- `withTimeout`, `withRetry` (2 tentativas no principal) e fallback em `resilient` (1 tentativa no modelo de reserva), em `src/llm/resilience.ts`. Cada chamada lógica vira uma linha em `llm_calls`.
- Prompts `src/prompts/v1/*` (`supervisor.v1`, `telemetry-react.v1`, `planner.v1`, `auditor.v1` e `postmortem.v1`), com schema de entrada e de saída. `npm run fixtures:rehash`.
- `TraceSink`: valida, redige, numera e persiste os eventos.
- Nó `telemetry_analyst` com laço ReAct de até 12 passos dentro do nó. Erro de ferramenta vira observação. A observação entra no prompt seguinte como dado delimitado.
- CLI `diagnose`.

## Non-goals

- Tool calling nativo do modelo: o ReAct usa saída estruturada, para funcionar com modelos sem tool calling e para o fake roteirizar cada passo.
- Subgrafo para o ReAct: ele herdaria o `recursionLimit` do grafo pai e estouraria antes do 12º passo.
- Avaliação de qualidade do modelo ou benchmark: `test:live` só confere estrutura.
- Memória episódica, rolling summary ou `ContextBuilder`.
- Streaming de tokens.

## Critérios de aceite (EARS)

- **AC-05** Se o analista completar 12 passos ReAct sem resposta final, então o sistema deve encerrar o laço sem lançar `GraphRecursionError`, gravar diagnóstico com `confidence: "low"` e `capReached: true` e escalar com `react_cap_low_confidence` sem chamar o planejador.
- **AC-07** Quando uma ferramenta falhar, não existir ou receber argumentos inválidos, o sistema deve devolver o problema como `observation` com `ok: false` e continuar o laço.
- **AC-26** Se o fake receber chamada sem turno roteirizado correspondente, ou se o hash de `version + system` divergir do registrado, então deve lançar `UnscriptedLlmCallError` (com cenário, prompt, número da chamada, digest e chaves) ou `FixturePromptDriftError` antes de responder.
- **AC-28** Se um teste de cenário em modo estrito terminar com turnos não consumidos, então o teste deve falhar listando os ids.
- **AC-29** Se o modelo principal falhar duas vezes, então o sistema deve tentar o modelo de fallback; se ele também falhar, deve marcar o incidente `escalated` com `llm_unavailable`, gerar post-mortem parcial pelo template e a API deve responder 503.
- **AC-31** Quando a saída estruturada do LLM falhar no `safeParse`, o sistema deve tratá-la como falha da tentativa e nunca usar dado não validado.

## Como verificar

| Critério | Testes |
|---|---|
| AC-05 | `tests/e2e/telemetry.e2e.test.ts` ("12 steps without final: low confidence, capReached, and no GraphRecursionError inside a graph with recursionLimit 25"); `tests/e2e/team.e2e.test.ts` ("react cap escalates without calling the planner") |
| AC-07 | `tests/unit/tools.unit.test.ts` ("invalid args and unknown tools are observations, not exceptions"); `tests/e2e/telemetry.e2e.test.ts` |
| AC-26 | `tests/unit/fake-provider.unit.test.ts` ("unscripted call throws with diagnostics", "prompt drift throws before answering") |
| AC-28 | `tests/unit/fake-provider.unit.test.ts` ("assertAllConsumed lists leftovers and honors except"); `tests/e2e/scenarios.e2e.test.ts` |
| AC-29 | `tests/unit/resilience.unit.test.ts` ("falls back after two primary failures", "fails when primary and fallback fail"); `tests/e2e/resilience.e2e.test.ts` (503) |
| AC-31 | `tests/unit/resilience.unit.test.ts` ("OpenRouterProvider maps usage, invalid output and HTTP errors"); `tests/unit/fake-provider.unit.test.ts` ("simulated errors and schema-invalid outputs are failures") |

Marco demonstrável: `npm run cli -- diagnose --scenario deploy-5xx-rollback` imprime pensamento, ação e observação dos 3 passos e o diagnóstico `bad_deploy` com confiança alta.

## Referência

Documento de design do incident-copilot, revisão 2, de 2026-10-04. Ele fica no repositório do curso, fora deste repositório. Seções:

- "4.3 Interfaces entre componentes";
- "6.2 Tetos";
- "7. Provedor fake", em especial "7.2 Formato das fixtures";
- "8.3 Critérios de aceite em EARS".

O formato das fixtures e as regras do fake estão em `docs/fake-provider.md`.
