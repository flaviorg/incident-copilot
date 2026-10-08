# 004: Portão de remediação

Marco M4. Estado: implementado.

## Contexto

É aqui que a tese do projeto vira código: o modelo propõe a remediação, mas quem decide o que roda é o código e, nas ações de risco, um humano. O portão:

- classifica cada passo pela Matriz de Autonomia;
- roda o dry run no mundo simulado;
- pede aprovação para a faixa 3;
- barra a faixa 4 por construção.

A execução só começa depois que todas as decisões do lote estão tomadas. Um canário confere a recuperação e reverte o que não funcionou.

## Escopo

- Catálogo de ações e `classifyAction`: faixa do catálogo e regras de contexto que só sobem a faixa. A matriz em `docs/autonomy-matrix.md` é gerada do catálogo.
- Máquina de estados da aprovação (`transition`, `effectiveStatus`), com expiração projetada na leitura e materializada na decisão. `parseDecision`, com lista fechada de termos.
- Proteções com relógio injetado: circuit breaker (3 falhas, 300 s), limitador de execuções (5 por minuto, mesma ação no mesmo alvo 1 vez em 10 min) e limitador de tentativas de token (5 em 10 min bloqueiam 10 min).
- `SimulatedInfra`: dry run, execução, reversão e séries pós-ação, com um executor por tipo em `Record<ExecutableActionType, Executor>`.
- Nós `gate`, `executor` e `verifier`, nenhum deles com LLM.
- `ApprovalService`:
  - corpo;
  - token configurado;
  - bloqueio;
  - token;
  - texto ambíguo;
  - existência;
  - expiração;
  - status;
  - transição e retomada.
- Fixtures completas dos 2 cenários, golden de métricas, teste de injeção por log e CLI `demo`.

## Non-goals

- Ações reais em infraestrutura: tudo roda sobre o mundo simulado.
- Autenticação multiusuário e RBAC: um token único prova o padrão.
- Agendador que materializa a expiração sem uma tentativa de decisão (backlog v2).
- Regra de subida de faixa por custo estimado (backlog v2).
- Ações do catálogo sem uso nos cenários da v1 (`scale_out`, `rolling_restart` e outras, backlog v2).
- Qualquer caminho em que o LLM decida faixa, aprovação ou execução.

## Critérios de aceite (EARS)

- **AC-10** O sistema deve definir a faixa de cada passo por `classifyAction`, sem ler faixa da saída do LLM, e nenhuma regra de contexto pode baixar a faixa do catálogo.
- **AC-11** Quando um passo for de faixa 4 ou de tipo fora do catálogo, inclusive quando proposto depois de um log com instrução embutida, o sistema deve bloqueá-lo sem dry run e sem fila, com status `blocked_forbidden` ou `blocked_unknown`, gravando auditoria e `critique` do portão com `verdict: "blocked"`.
- **AC-12** Quando o portão processar um passo executável, o sistema deve: com dry run falho, marcá-lo `rejected_by_dry_run` sem criar aprovação; em faixa 2 com dry run ok, marcá-lo `ready`; em faixa 3 com dry run ok, criar aprovação `pending` e deixar o incidente `awaiting_approval`; e não executar nenhum passo do lote antes de todas as decisões.
- **AC-13** Quando a decisão chegar em texto livre, o sistema deve aceitar apenas as frases exatas das listas de aprovar e rejeitar, depois da normalização, e responder 422 `ambiguous_decision` a qualquer outro texto, sem mudar o estado.
- **AC-14** Quando um humano rejeitar uma aprovação, o sistema deve cancelar o passo e os passos que dependem dele, sem registrar sucesso para nenhum deles, e marcar o incidente `escalated` com `mitigation_rejected` se nenhuma ação mitigadora for executada.
- **AC-15** Enquanto uma aprovação `pending` estiver vencida, as leituras devem mostrá-la como `expired` sem gravar nada; quando chegar uma decisão para ela, o sistema deve materializar a expiração das aprovações vencidas do incidente, responder 409 `approval_expired` e, sem pendências restantes, retomar tratando a expiração como rejeição.
- **AC-19** Se o circuit breaker estiver aberto ou o limite global ou por alvo de execuções for excedido, então o sistema deve marcar o passo `blocked_circuit_open` ou `throttled`, não executá-lo e escalar com `circuit_open` ou `throttled`.
- **AC-20** Quando o canário reprovar depois de uma execução, o sistema deve reverter as ações reversíveis executadas em ordem inversa, gravar `canary_rollback`, registrar falha no breaker e escalar com `remediation_ineffective`.
- **AC-24** Quando o cenário `cost-anomaly` terminar com todas as aprovações aprovadas, o sistema deve reportar como economia mensal a soma das economias dos achados de inventário das ações executadas, calculada a partir de `inventory.json` e `data/cloud-prices.json`.
- **AC-38** Quando `npm run demo` rodar sem `--live`, o sistema deve usar o provedor fake mesmo com `OPENROUTER_API_KEY` no ambiente, concluir o cenário padrão em menos de 10 segundos com código 0 e indicar no cabeçalho que o provedor é fake.

Matriz de Autonomia (seção 6.4 do design):

| Faixa | Regra | Ações da v1 |
|---|---|---|
| 1 Decide sozinho | Leitura, risco zero | as 4 ferramentas de leitura |
| 2 Decide e registra | Reversível ou sem efeito no serviço | `add_incident_note`, `block_image_tag`, `tag_resource_for_review`, `create_volume_snapshot` |
| 3 Exige aprovação humana | Destrutivo ou alto impacto | `rollback_deployment`, `release_elastic_ip`, `delete_volume`, `resize_instance` |
| 4 Proibido por construção | Expor dados, apagar auditoria ou backup, desligar controle | `delete_audit_log`, `disable_security_scanner`, `export_user_data`, `run_arbitrary_command`, `delete_backups` e qualquer tipo fora do catálogo |

Regras de contexto que sobem para a faixa 3:

- alvo fora do serviço ou da conta do incidente;
- passo sem `runbookRef`;
- plano que chegou ao portão com as revisões esgotadas.

## Como verificar

| Critério | Testes |
|---|---|
| AC-10 | `tests/unit/autonomy.unit.test.ts` ("context rules only raise", "forbidden and unknown are tier 4") |
| AC-11 | `tests/e2e/injection.e2e.test.ts`; `tests/e2e/scenarios.e2e.test.ts` ("cost approved: Reflection, tier 4 blocked, savings from the inventory") |
| AC-12 | `tests/unit/nodes-gate.unit.test.ts`; `tests/e2e/gate.e2e.test.ts` |
| AC-13 | `tests/unit/parse-decision.unit.test.ts`; `tests/e2e/gate.e2e.test.ts` ("ambiguous text changes nothing; exact text decides") |
| AC-14 | `tests/e2e/gate.e2e.test.ts` ("reject cancels dependents and escalates mitigation_rejected") |
| AC-15 | `tests/unit/approval-machine.unit.test.ts`; `tests/e2e/gate.e2e.test.ts` ("expired approval: reads project it, decision materializes it and answers approval_expired") |
| AC-19 | `tests/unit/guards.unit.test.ts`; `tests/e2e/gate.e2e.test.ts` ("failed dry run, open breaker, full limiter and failing canary end as the spec says") |
| AC-20 | `tests/unit/canary.unit.test.ts`; `tests/e2e/gate.e2e.test.ts` |
| AC-24 | `tests/unit/inventory-audit.unit.test.ts`; `tests/e2e/scenarios.e2e.test.ts` (golden `metrics.cost-anomaly.approved.json`) |
| AC-38 | `tests/e2e/cli.e2e.test.ts` ("demo runs offline with fake provider even with a key in the environment") |

Marco demonstrável: `npm run demo` completo; `npm run demo -- --reject` termina `escalated`; `npm run demo -- --scenario cost-anomaly` mostra o Reflection, a faixa 4 bloqueada e US$ 339,59 de economia mensal.

## Referência

Documento de design do incident-copilot, revisão 2, de 2026-10-04. Ele fica no repositório do curso, fora deste repositório. Seções:

- "6.4 Matriz de Autonomia e catálogo de ações";
- "6.5 Máquina de estados da aprovação";
- "6.7 Circuit breaker, rate limit e canário";
- "6.10 Modelo de ameaças";
- "8.3 Critérios de aceite em EARS".

Máquina de estados em `docs/architecture.md`; ameaças e defesas em `docs/threat-model.md`; matriz gerada em `docs/autonomy-matrix.md`.
