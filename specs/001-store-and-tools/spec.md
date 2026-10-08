# 001: Store e ferramentas

Marcos M0 (Fundação) e M1 (Store e ferramentas). Estado: implementado.

## Contexto

O copiloto precisa de uma base determinística antes de qualquer agente:

- contratos compartilhados por backend, MCP e War Room;
- persistência com auditoria à prova de adulteração;
- dados de cenário próprios e reprodutíveis;
- ferramentas de leitura com saída curta;
- recuperação de runbooks com recusa;
- números calculados por funções puras.

Nada aqui chama LLM. Esta spec também guarda os critérios que valem para o repositório inteiro (testes sem rede, regra de dependência, pre-commit e CI), por ser a fundação de todas as outras.

## Escopo

- `src/config.ts`: config validada por Zod, que falha cedo sem ecoar valores. `src/infra/redact.ts` e logger JSON em stderr. `tests/setup/no-network.ts` bloqueia `fetch` nos testes.
- `src/contracts/*`: schemas Zod 4 e tipos. `src/domain/canonical-json.ts` e `src/domain/errors.ts`.
- `SqliteIncidentStore` sobre `node:sqlite`:
  - prepared statements e transação manual;
  - versão otimista do blackboard;
  - `CHECK` gerados dos enums Zod;
  - auditoria só de inserção, com gatilhos e hash encadeado, na ordem de `seq INTEGER PRIMARY KEY AUTOINCREMENT` (schema versão 2; a versão 1 é migrada ao abrir o banco);
  - ids sequenciais por contador no banco.
- Relógio simulado e do sistema; séries determinísticas com PRNG semeado; os cenários `deploy-5xx-rollback` e `cost-anomaly` com dados próprios.
- 4 ferramentas de leitura (faixa 1): `query_metrics`, `query_logs`, `list_deploys` e `audit_cloud_inventory`, com parâmetros Zod e resumo de até 600 caracteres.
- Auditoria de inventário FinOps; BM25 por seção de runbook com frontmatter restrito e limiar normalizado; canário (`analyzeCanary`); métricas do incidente; guarda numérico e template do post-mortem.
- CLI `scenarios` e `tool`.
- Repositório: `check:secrets`, `.githooks/pre-commit` e CI.

## Non-goals

- Infraestrutura real (Kubernetes, Prometheus, AWS, Terraform): o mundo é simulado por dados determinísticos.
- Embeddings ou banco vetorial: a recuperação é lexical (BM25).
- ORM, parser YAML genérico, `dotenv` ou `tsx`.
- Agendador de tarefas ou fila externa.
- Cenários `memory-leak-saturation` e de CVE (backlog v2).

## Critérios de aceite (EARS)

- **AC-21** O sistema deve impedir `UPDATE` e `DELETE` na tabela de auditoria por gatilho do banco, e cada linha deve guardar o hash da anterior calculado sobre o JSON canônico da seção 6.8.
- **AC-22** O sistema deve calcular MTTD, MTTR, tempo aguardando aprovação, economia mensal e as faixas ilustrativas de minutos economizados e ROI por funções puras, sem chamar o LLM, rotulando cada valor como `measured`, `assumption` ou `derived`.
- **AC-25** Quando nenhuma seção de runbook atingir o escore normalizado mínimo, o recuperador deve registrar recusa (`runbookMatches` vazio) em vez de devolver o menos ruim.
- **AC-27** Enquanto `npm test` estiver rodando, toda chamada de `fetch`, no processo de teste e nos processos filhos, deve falhar com `NetworkDisabledInTests`.
- **AC-40** O sistema deve manter `src/contracts` e `src/domain` sem imports `node:*` nem de camadas externas, os enums dos `CHECK` do SQL iguais aos enums Zod e `docs/autonomy-matrix.md` igual ao gerado do catálogo.
- **AC-41** O pre-commit deve rodar typecheck, testes unitários e varredura de segredos e bloquear o commit em caso de falha; o CI deve rodar typecheck (backend e web), testes do backend, testes da web, build da web, `check:tokens` e `check:secrets` sem nenhum segredo configurado.

Critérios de outros marcos que usam peças daqui:

- o guarda numérico na narrativa (AC-23) está em `003-supervisor-team`;
- a economia mensal do cenário de custo de ponta a ponta (AC-24) está em `004-remediation-gate`.

## Como verificar

| Critério | Testes |
|---|---|
| AC-21 | `tests/unit/store-audit.unit.test.ts`, `tests/unit/canonical-json.unit.test.ts` |
| AC-22 | `tests/unit/metrics.unit.test.ts` |
| AC-25 | `tests/unit/bm25.unit.test.ts` ("refuses below the threshold instead of returning the least bad") |
| AC-27 | `tests/unit/no-network.unit.test.ts` ("fetch is disabled during tests" e "child processes started by the test helpers also have fetch disabled (AC-27)"); a CLI (`runCli`) e o MCP de teste sobem os filhos com `CHILD_NODE_ARGS` de `tests/helpers/spawn.ts` |
| AC-40 | `tests/unit/contracts.unit.test.ts`, `tests/unit/store-audit.unit.test.ts`, `tests/unit/docs-matrix.unit.test.ts` |
| AC-41 | `tests/unit/check-secrets.unit.test.ts`; `sh .githooks/pre-commit`; `.github/workflows/ci.yml` |

Marco demonstrável: `npm run cli -- tool audit_cloud_inventory --scenario cost-anomaly --args '{"account":"data-platform"}'` mostra US$ 339,59 de economia potencial.

## Referência

Documento de design do incident-copilot, revisão 2, de 2026-10-04. Ele fica no repositório do curso, fora deste repositório. Seções:

- "2.1 Fronteira v1";
- "4.2 Componentes e responsabilidade única";
- "5.6 Configuração";
- "5.7 Fórmulas das métricas";
- "6.6 Segredos e redação";
- "6.8 Trilha de auditoria";
- "7.3 Cenários de demo";
- "8.3 Critérios de aceite em EARS".

Números de seção citados nos critérios (como "seção 6.8") apontam para esse documento. O necessário daquelas seções está copiado acima. As fórmulas também estão em `src/domain/metrics/incident-metrics.ts`, e a cadeia de hash em `src/infra/db/incident-store.ts`.
