# 0001: O provedor fake consumia o roteiro por processo, e o 2º incidente da API respondia 500

- **Data:** 2026-10-04
- **Área:** provedor fake (`src/llm/fake-provider.ts`), com efeito na API HTTP e no servidor MCP
- **Severidade:** média. Com o provedor padrão, a API e o MCP só atenderiam um incidente por cenário até reiniciar. Foi pega antes de qualquer publicação.
- **Status:** resolvido

## Resumo

Com o provedor fake, o segundo `POST /incidents` do mesmo cenário, no mesmo processo da API, respondia 500. O fake marcava cada turno do roteiro como consumido para o processo inteiro. O segundo incidente encontrava o roteiro já gasto pelo primeiro, e a chamada ao supervisor lançava `UnscriptedLlmCallError`. A correspondência passou a considerar só os turnos consumidos pelo próprio incidente.

## Impacto

- **Nada chegou a quem usa:** o projeto não tinha sido publicado.
- **Quem seria afetado:** qualquer pessoa que subisse `npm start` ou `npm run mcp` com o provedor padrão (`LLM_PROVIDER=fake`) e abrisse um segundo incidente do mesmo cenário sem reiniciar o processo.
- **Como apareceria:** como 500 `internal_error`, com o detalhe só no log, porque erro de fixture é tratado como defeito do repositório e não vira escalonamento.
- **Fora do alcance:** com o provedor OpenRouter não havia efeito.
- **Por que a demo não mostrava:** a CLI e todos os testes até ali abriam um incidente por processo.

## Linha do tempo

Tudo em 2026-10-04, durante a Tarefa 33 (rotas de incidentes e aprovações). Horários não foram registrados.

1. Um teste novo de `tests/e2e/http.e2e.test.ts` abre dois incidentes `deploy-5xx-rollback` no mesmo `buildServer`, para conferir que cada requisição leva o próprio `X-Request-Id` ao trace e à auditoria.
2. O segundo `POST /incidents` responde 500. O log de teste mostra `UnscriptedLlmCallError` no `supervisor.v1`, com "turnos deste prompt 4/5 consumidos".
3. A mensagem do erro aponta o prompt, as `matchKeys` e a contagem de turnos consumidos, e leva à causa: o fake guardava o consumo num conjunto único do processo.
4. Um teste unitário novo em `fake-provider.unit.test.ts` reproduz o cenário sem HTTP: dois incidentes do mesmo roteiro no mesmo provedor.
5. A correspondência passa a usar a chave `(incidentId, cenário, turno)`, e o modo estrito continua usando a união. Os dois testes ficam verdes, e a suíte inteira continua verde.

## Causa

O spec (seção 7.2, regra 2) diz que o fake procura "o primeiro turno não consumido daquele prompt". A primeira implementação leu "não consumido" como "não consumido por ninguém neste processo". Isso bastava para o modelo mental de um incidente por execução, que valia para todos os usos até a Tarefa 32:

- a CLI `demo`;
- os testes de cenário;
- o gravador da War Room.

A API e o servidor MCP mudaram essa premissa: são processos de longa duração e atendem vários incidentes. Nenhum teste anterior abria dois incidentes do mesmo cenário no mesmo container, então a suposição nunca foi exercitada.

## O que funcionou

- **Erro com diagnóstico.** O `UnscriptedLlmCallError` (regra 3 do spec) carrega o prompt, as chaves de correspondência e a contagem de turnos consumidos. Isso apontou a causa direto.
- **O teste que achou o defeito foi escrito para outra coisa:** propagar o `requestId`. Um teste de ponta a ponta com um cenário um pouco mais realista que o mínimo pegou a premissa errada.
- **Tratamento de erro de fixture.** Separar erro de fixture de escalonamento fez o problema aparecer como 500 alto e claro, em vez de virar um incidente "escalado" que pareceria comportamento normal.

## O que não funcionou

- Os testes de cenário rodavam em modo estrito, mas um incidente por container. O modo estrito prova que o roteiro foi todo consumido, não que pode ser consumido de novo.

## Ações

| Ação | Tipo | Prova |
|---|---|---|
| Correspondência por incidente (`ctx.incidentId`); modo estrito pela união dos turnos consumidos | correção | `fake-provider.unit.test.ts` ("each incident replays the script from the start (same scenario, same process)") |
| Teste HTTP que abre o segundo incidente do mesmo cenário no mesmo processo, com `X-Request-Id` próprio | detecção | `http.e2e.test.ts` ("list, view, trace, audit and postmortem readiness") |
| Comentário no código e regra documentada em `docs/fake-provider.md` | prevenção | revisão |

## Lições

Um dublê de teste também tem premissas de ciclo de vida. Quando o mesmo componente passa a servir um processo de longa duração, vale um teste que repita a operação no mesmo processo.
