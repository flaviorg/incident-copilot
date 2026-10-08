# 003: Equipe com supervisor

Marco M3. Estado: implementado.

## Contexto

Um incidente real pede mais de um papel: investigar, achar o procedimento, planejar, revisar o plano e relatar. Este marco monta a equipe num `StateGraph` do LangGraph:

- um supervisor que só orquestra;
- especialistas criados por fábricas com injeção de dependência;
- um blackboard em Zod como estado único.

O LLM escolhe o próximo especialista, mas o código valida a escolha, impõe os tetos e decide todo escalonamento.

## Escopo

- Blackboard (`BlackboardSchema`) e grafo (`src/graph/graph.ts`), com rotas puras em `src/graph/routing.ts` e `pathMap` explícito.
- Nó `supervisor`:
  - confere os tetos antes do LLM;
  - passa pela guarda de pré-condições (`guardChoice` em `src/domain/supervisor/supervisor-guard.ts`), e escolha inválida vira `critique` com `verdict: "coerced"`;
  - grava handoff e histórico.
- Nó `runbook_retriever` (BM25, sem LLM e sem repetição), nó `remediation_planner` (vê o catálogo como texto, sem ferramentas) e nó `auditor`, com regras em código como piso, veredito do LLM e até 2 revisões (Reflection).
- Nó `reporter`:
  - métricas puras;
  - linha do tempo gerada por código;
  - narrativa do LLM passando pelo guarda numérico;
  - template determinístico quando o guarda reprova ou o incidente escala.
- Nó `escalation`, sem LLM.
- `IncidentService`:
  - abre o incidente;
  - executa o grafo por `stream` com `recursionLimit` e `AbortSignal.timeout`;
  - guarda o último estado;
  - deriva e persiste o status (`deriveIncidentStatus`).
- Container com todos os serviços.

## Non-goals

- Checkpointer e `interrupt()` do LangGraph: a pausa persiste o blackboard no SQLite e a retomada é uma nova invocação.
- LangGraph Studio e `langgraph.json`.
- Roteador de estratégias (ReAct, Plan-and-Execute e Reflection como rotas escolhidas pelo modelo).
- Padrão Juiz com dois pareceres e protocolo Agent-to-Agent.
- Escalonamento escolhido pelo LLM: `SupervisorDecisionSchema` não tem essa opção.

## Critérios de aceite (EARS)

- **AC-02** O sistema deve gravar um evento `handoff` para cada decisão do supervisor, para cada retorno de especialista ao supervisor e para cada passagem entre portão, humano e executor, com `from`, `to`, `brief` e `reason`.
- **AC-03** Se o supervisor escolher um passo cujas pré-condições não estão satisfeitas, então o sistema deve rejeitar a escolha, gravar `critique` com `by: "supervisor_guard"` e `verdict: "coerced"` e seguir a rota canônica.
- **AC-04** Se o supervisor for acionado com `supervisor.iterations` acima de `limits.teamMaxIterations`, então o sistema deve parar sem chamar o LLM, marcar `escalated` com `team_cap_reached` e gerar post-mortem `partial` pelo template.
- **AC-06** Se uma invocação do grafo exceder o limite de recursão, então o sistema deve capturar o erro, marcar `escalated` com `recursion_limit`, manter o trace gravado e preservar no blackboard o último estado emitido (incluindo diagnóstico e plano já obtidos).
- **AC-08** Quando o auditor avaliar um plano, o sistema deve aplicar as regras de 4.7 como piso: veredito do LLM `approve` com regra falha vira `revise` registrado como sobrescrito; `revise` volta ao planejador no máximo 2 vezes; esgotadas as revisões, todos os passos sobem para faixa 3.
- **AC-09** Se o diagnóstico continuar com confiança `low` depois de 2 rodadas do analista, então o sistema deve escalar com `low_confidence_diagnosis` sem chamar o planejador.
- **AC-23** Se a narrativa do post-mortem contiver número que não corresponde a nenhum valor calculado, do timeline ou das evidências, então o sistema deve descartar a narrativa, usar o template determinístico e gravar `critique` com `by: "numeric_guard"` listando os números rejeitados.

Regras do auditor (seção 4.7 do design):

| Regra | O que exige |
|---|---|
| `snapshot_before_delete` | Todo `delete_volume` tem um `create_volume_snapshot` no mesmo alvo em passo anterior, listado em `dependsOn` |
| `resize_requires_low_cpu` | `resize_instance` para tipo menor exige CPU média de 14 dias de no máximo 10% |
| `release_requires_unassociated` | `release_elastic_ip` exige IP sem associação |
| `rollback_requires_recent_deploy` | `rollback_deployment` exige deploy do mesmo serviço até 60 min antes do impacto e `toVersion` igual à versão anterior a ele |
| `depends_on_valid` | Todo `dependsOn` aponta para passo de ordem menor que existe no plano |

## Como verificar

| Critério | Testes |
|---|---|
| AC-02 | `tests/e2e/team.e2e.test.ts` ("every supervisor decision and specialist return has a handoff"); `tests/e2e/scenarios.e2e.test.ts` |
| AC-03 | `tests/unit/supervisor-guard.unit.test.ts`; `tests/e2e/team.e2e.test.ts` ("guard coercion keeps the flow going") |
| AC-04 | `tests/e2e/team.e2e.test.ts` ("team cap (limit 3) escalates with a partial template report") |
| AC-06 | `tests/e2e/team.e2e.test.ts` ("recursion limit (5) escalates and keeps the last state") |
| AC-08 | `tests/unit/auditor-rules.unit.test.ts` ("verdict combination: code is the floor"); `tests/e2e/team.e2e.test.ts` ("cost: Reflection sends the plan back once") |
| AC-09 | `tests/e2e/team.e2e.test.ts` ("low confidence after two runs escalates as low_confidence_diagnosis") |
| AC-23 | `tests/unit/numeric-guard.unit.test.ts`; `tests/unit/nodes-reporter.unit.test.ts` (fixture `invented-numbers.json`) |

## Referência

Documento de design do incident-copilot, revisão 2, de 2026-10-04. Ele fica no repositório do curso, fora deste repositório. Seções:

- "4.5 O grafo", com "4.5.1 Rotas decididas por código" e "4.5.2 Fase e status por nó";
- "4.6 Especialistas";
- "4.7 Regras do auditor: o código é o piso";
- "6.2 Tetos";
- "6.3 Guarda do supervisor";
- "8.3 Critérios de aceite em EARS".

Números de seção citados nos critérios (como "regras de 4.7") apontam para esse documento. Diagramas e tabela de rotas em `docs/architecture.md`.
