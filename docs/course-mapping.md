# Mapa de aulas para o código

Este projeto parte de práticas do curso de Engenharia de Software com IA Aplicada (UNIPDS) e as transporta para outro domínio, com dados próprios. A tabela abaixo cita cada aula **só pelo ID e pelo tema**, o arquivo do projeto onde a prática aparece e o que o código prova. Nenhum trecho de transcrição, slide ou material autoral foi copiado. Os cenários, nomes de serviço, mensagens de log, inventário e preços são do projeto: as aulas inspiram o mecanismo, não os números.

O tema de cada linha é o tópico da aula, resumido com palavras próprias. Quando várias aulas formam uma série sobre o mesmo projeto, o tema cita a série, e a coluna "Prática provada" diz qual parte dela o projeto aproveita.

## Módulo 01: fundamentos

| Aula | Tema | Arquivo no projeto | Prática provada |
|---|---|---|---|
| 198027 | Introdução ao curso: critério de replicar com outro domínio | `fixtures/scenarios/`, `README.md` ("O que mudei em relação à aula") | Mecanismos das aulas sobre dados próprios, com a lista do que mudou |
| 198069 | Prompt engineering: prompt em blocos e validação por schema | `src/prompts/v1/*.ts` | Prompt com papel, regras e formato, validado por schema na saída |
| 198071 | Ferramentas de IA para devs: papéis, permissões mínimas e SDD | `src/mcp/tools/propose-remediation.ts` | Nenhuma tool MCP aprova nem executa; aprovação só por HTTP com token |
| 198081 | RAG, embeddings e busca semântica: fluxo e configuração por ambiente | `src/infra/runbooks/runbook-repository.ts`, `src/config.ts` | Busca por seção sobre `runbooks/`; modelo e provedor trocados por variável de ambiente |
| 198082 | RAG, embeddings e busca semântica: score mínimo, recusa e prompt versionado | `src/domain/retrieval/bm25.ts`, `src/prompts/v1/` | Escore normalizado com limiar de recusa; prompts como configuração versionada (`<id>.v1`) |

## Módulo 02: APIs, LangGraph e prompts

| Aula | Tema | Arquivo no projeto | Prática provada |
|---|---|---|---|
| 200953 | Mercado de IA como serviço: gateway de modelos com Fastify e OpenRouter | `src/llm/openrouter-provider.ts`, `src/http/server.ts` | `ChatOpenAI` com `baseURL` configurável; Fastify como servidor HTTP |
| 200954 | Mercado de IA como serviço: config que falha cedo, versões fixadas e testes com `app.inject` | `src/config.ts`, `.env.example`, `tests/e2e/http.e2e.test.ts` | Config validada por Zod que falha sem ecoar valores; testes HTTP sem abrir porta |
| 200955 | Série LangChain.js (200955 a 200959): pipeline LangGraph de comandos | `src/graph/graph.ts` | Grafo com estado em Zod 4, sem gerador de template |
| 200956 | Série LangChain.js: pipeline LangGraph de comandos | `src/graph/state.ts` | Blackboard Zod como estado único do grafo |
| 200957 | Série LangChain.js: pipeline LangGraph de comandos | `src/graph/routing.ts` | `addConditionalEdges` com funções de rota puras e `pathMap` explícito |
| 200958 | Série LangChain.js: pipeline LangGraph de comandos | `src/graph/nodes/escalation-node.ts` | Toda rota de falha cai no escalonamento, decidida por código |
| 200959 | Série LangChain.js: pipeline LangGraph de comandos; leitura sobre humano no laço | `src/app/incident-service.ts` | Pausa para decisão humana com blackboard persistido e retomada explícita |
| 200960 | Prompt chaining e JSON prompts: etapas com contrato | `src/contracts/*.ts` | Cada etapa do grafo tem schema de entrada e de saída |
| 200961 | Prompt chaining e JSON prompts: saída estruturada nativa | `src/llm/openrouter-provider.ts` | `withStructuredOutput` com JSON Schema, sem `JSON.parse` manual |
| 200962 | Prompt chaining e JSON prompts: testes primeiro e fallback seguro | `tests/unit/*`, `src/graph/nodes/reporter-node.ts` | TDD em todo o projeto; narrativa reprovada cai no template |
| 200963 | Prompt chaining e JSON prompts: "confio, mas confiro", DI pela fábrica e estado parcial | `src/graph/nodes/*.ts` | `safeParse` nos nós de negócio; cada nó recebe só o que usa; nós de ação sem LLM |
| 200968 | Memória e compactação de contexto: testar estrutura, não texto livre | `tests/e2e/scenarios.e2e.test.ts` | Asserções sobre enums, estado e números, nunca sobre a narrativa |
| 200969 | Série prompt injection, hijacking e guardrails (200969 a 200972) | `tests/fixtures/llm/injected-logs.json` | Log hostil com instrução embutida chega ao prompt do analista |
| 200970 | Série prompt injection, hijacking e guardrails | `src/domain/autonomy/catalog.ts` | Catálogo fechado que nega por padrão |
| 200971 | Série prompt injection, hijacking e guardrails | `src/domain/autonomy/catalog.ts` | Faixa calculada só por código, sem campo de faixa na saída do modelo |
| 200972 | Série prompt injection, hijacking e guardrails: testes do guardrail | `tests/e2e/injection.e2e.test.ts` | `delete_backups` proposto depois da injeção termina `blocked_forbidden`, com auditoria |
| 200978 | RAG avançado (Text-to-Cypher): erro antes do sucesso, limite de recursão, falta de testes sem LLM | `src/app/incident-service.ts`, `src/llm/fake-provider.ts` | `recursionLimit` 25 com estado preservado; suíte inteira com fake roteirizado |
| 200980 | Multimodais e monitoramento com Langfuse: traces, custo e avaliação | `src/llm/recording-provider.ts`, `src/app/stats-service.ts` | Cada chamada vira linha em `llm_calls` com tokens, custo e erro; `/stats` agrega |

## Módulo 03: MCP

| Aula | Tema | Arquivo no projeto | Prática provada |
|---|---|---|---|
| 203474 | Construindo uma tool customizada no LangChain | `src/tools/registry.ts`, `src/mcp/tools/*.ts` | Descrições que dizem quando usar a ferramenta; parâmetros Zod |
| 203477 | Entendendo agents e instructions | `AGENTS.md`, `specs/constitution.md` | Instruções factuais com menos de 100 linhas; dependência nova exige justificativa |
| 203479 | MCP do zero: testes automatizados via cliente MCP e inspeção | `tests/helpers/mcp-client.ts`, `tests/e2e/mcp.e2e.test.ts` | `Client` e `StdioClientTransport` nos testes; stdout só com JSON-RPC |
| 203482 | Template inicial, arquitetura e organização de código de um servidor MCP | `src/mcp/create-mcp-server.ts` | Servidor fino sobre os serviços de aplicação |
| 203483 | Como empresas usam MCP para conectar IA a sistemas legados | `src/mcp/server.ts` | Mesmo store e mesmos schemas da API |
| 203484 | Tools de listagem e criação | `src/mcp/tools/list-incidents.ts` | Filtro e `LIMIT` em SQL, não em memória |
| 203485 | Tools de atualização e remoção e uso no VS Code | `src/mcp/tools/propose-remediation.ts` | Cada teste cria os próprios dados; erro sem detalhe interno |

## Módulo 04: agentes

| Aula | Tema | Arquivo no projeto | Prática provada |
|---|---|---|---|
| 221503 | O agente de código por dentro (GitHub Copilot) | `AGENTS.md` | Instruções do repositório para agentes de código |
| 221504 | Engenharia de contexto e contrato de permissões | `AGENTS.md` | Regras explícitas do que um agente pode e não pode fazer no repositório |
| 221505 | Spec-driven development do zero, parte 1 | `specs/00N-*/spec.md` | Critérios de aceite em EARS por marco |
| 221506 | Spec-driven development do zero, parte 2 | `specs/constitution.md`, `.githooks/pre-commit` | Princípios inegociáveis; hook com typecheck, testes unitários e varredura de segredos |
| 221507 | Guardrails, revisor e delegação | `scripts/check-secrets.ts` | Guardrail determinístico que valida o resultado |
| 221508 | Três padrões de raciocínio | `src/graph/nodes/telemetry-node.ts`, `src/graph/nodes/auditor-node.ts` | ReAct no analista e Reflection no auditor |
| 221509 | Configurando o Spec Kit | `specs/` | Specs numeradas por feature, com constitution |
| 221510 | Estrutura inicial do projeto com Spec Kit | `src/app/container.ts`, `fixtures/scenarios/` | Composição única para API, MCP, CLI e testes; cenários sintéticos determinísticos em vez de store mockado |
| 221511 | Definindo o padrão ReAct para o agente | `src/graph/nodes/telemetry-node.ts` | Laço pensamento, ação e observação com teto 12, sem estourar o limite de recursão |
| 221512 | Definindo o padrão Plan-and-Execute para o agente | `src/graph/nodes/planner-node.ts`, `src/app/trace-sink.ts` | Plano estruturado com até 8 passos; trace tipado persistido |
| 221513 | Críticas e benchmark com o padrão Reflection | `src/graph/nodes/auditor-node.ts`, `src/domain/audit/auditor-rules.ts` | Veredito Zod com até 2 revisões e piso de regras em código |
| 221514 | Uma API que também é um agente | `src/http/routes/incidents.ts` | Códigos 400, 422, 503 e 504; timeout de 180 s por execução |
| 221515 | Especificando a integração com banco de dados | `src/infra/db/sqlite.ts`, `src/infra/db/incident-store.ts` | `node:sqlite`, prepared statements, `:memory:` nos testes |
| 221516 | Criando e consultando incidentes no banco | `src/infra/db/schema.ts` | `CHECK` gerados dos enums Zod, sem divergência entre SQL e contrato |
| 221517 | Validando a disponibilidade de provedores externos | `src/tools/registry.ts` | Ferramenta que falha vira `observation` com `ok: false` e o laço segue |
| 221518 | Disponibilizando o agente via MCP | `src/mcp/server.ts`, `.vscode/mcp.json`, `.cursor/mcp.json` | Segunda porta sobre o mesmo store; logs em stderr |
| 221522 | O contexto como orçamento: medição e sumarização | `src/llm/usage.ts` | Estimativa de tokens (cerca de 4 caracteres por token) no fake |
| 221524 | LangGraph e fallback de modelo | `src/llm/resilience.ts` | 2 tentativas no principal, fallback e 503 |
| 221525 | Criando estratégias de observabilidade | `src/http/request-id.ts`, `src/app/stats-service.ts`, `src/domain/autonomy/catalog.ts` | `X-Request-Id`, logger JSON, `/stats` com P50 e P95 em SQL, faixas 1 a 4 |
| 221526 | Implementando a War Room | `web/src/` | War Room em React e Vite |
| 221527 | Publicando a War Room no GitHub Pages | `.github/workflows/pages.yml`, `web/vite.config.ts` | `base` do Vite e deploy só por disparo manual; modo demo no lugar do túnel |
| 221528 | Implementando multiagentes | `src/graph/nodes/supervisor-node.ts` | Supervisor que só orquestra, `brief`, handoffs no trace, teto de 8 |

## Módulo 05: UX e UI com IA

| Aula | Tema | Arquivo no projeto | Prática provada |
|---|---|---|---|
| 210738 | Pix App: design tokens gerados a partir do briefing de marca | `web/src/styles/tokens.css`, `scripts/check-tokens.ts` | Cores só em tokens; varredura que falha com cor literal fora deles |
| 210739 | Pix App: componente modal acessível | `web/src/components/ApprovalDialog.tsx` | `role="dialog"`, `aria-modal`, foco preso, Escape fecha |
| 210742 | Pix App: correções de contraste e de layout em tela estreita | `web/src/test/tokens-contrast.test.ts`, `web/src/styles/components.css` | Contraste de 4,5:1 provado por teste; uma coluna em tela estreita |
| 210744 | CFP Platform: biblioteca de contratos compartilhada entre front e back | `src/contracts/demo-recording.ts` | A War Room importa os schemas do backend |
| 210745 | CFP Platform: OpenSpec com non-goals | `specs/00N-*/spec.md` | Seção `## Non-goals` em cada spec |
| 210748 | CFP Platform: agente assíncrono entregando por PR, sem escrita na branch principal | `AGENTS.md` | Nada é publicado sem validação humana |
| 210764 | BragBot: interface com mock primeiro | `web/src/data/demo-source.ts` | War Room que roda só com gravações, sem backend |
| 210765 | BragBot: flow com Zod e validação em runtime | `web/src/data/demo-source.ts` | Gravação validada por `DemoRecordingSchema` no navegador; inválida vira erro explícito |

## Módulo 06: AIOps e engenharia agêntica

| Aula | Tema | Arquivo no projeto | Prática provada |
|---|---|---|---|
| 213409 | Agentes para Kubernetes (K8s AI-Ops): canário | `src/domain/canary/canary-analyzer.ts` | Limiar de 5% de 5xx em código |
| 213410 | Agentes para Kubernetes (K8s AI-Ops): desafio de fazer o canário falhar | `tests/e2e/gate.e2e.test.ts` | Cenário com séries ruins reprova o canário e reverte as ações |
| 213411 | Série troubleshooting e diagnóstico com ReAct (213411 a 213413) | `src/tools/query-metrics.ts` | Métricas de séries sintéticas determinísticas |
| 213412 | Série troubleshooting e diagnóstico com ReAct | `src/tools/query-logs.ts`, `src/tools/list-deploys.ts` | Logs agrupados por mensagem e versão; deploy suspeito com versão anterior |
| 213413 | Série troubleshooting e diagnóstico com ReAct | `src/contracts/diagnosis.ts` | Diagnóstico com categoria em enum, confiança e evidências citadas |
| 213417 | Série ChatOps e governança com humano no laço (213417 a 213419) | `src/app/approval-service.ts` | Decisão humana por HTTP, com token |
| 213418 | Série ChatOps e governança: o segredo de aprovação | `src/infra/redact.ts`, `tests/e2e/secrets.e2e.test.ts` | Token fora do código e redigido nas 7 superfícies de saída |
| 213419 | Série ChatOps e governança | `src/domain/approval/parse-decision.ts` | Lista fechada de termos; o resto é ambíguo e recebe 422 |
| 213428 | FinOps e otimização de custos (inspiração) | `src/domain/finops/inventory-audit.ts` | Volume sem anexo, IP sem associação e instância superdimensionada |
| 213429 | FinOps e otimização de custos (inspiração) | `data/cloud-prices.json`, `tests/unit/inventory-audit.unit.test.ts` | Economia mensal calculada de inventário e preços próprios |
| 213430 | RAG de runbooks e post-mortem automático | `runbooks/`, `src/infra/runbooks/runbook-repository.ts` | BM25 por seção, com recusa abaixo do limiar |
| 213431 | RAG de runbooks e post-mortem automático | `src/domain/report/postmortem-template.ts` | Post-mortem com resumo, causa, ação e prevenção; template determinístico |
| 213437 | Auto-remediação segura com guardrails | `src/infra/simulated-infra.ts`, `src/graph/nodes/gate-node.ts` | Dry run antes de qualquer fila; circuit breaker e rate limit |
| 213438 | Auto-remediação segura com guardrails | `src/domain/approval/approval-machine.ts` | Máquina de estados em código; rejeição cancela dependentes |
| 213439 | Projeto integrador (Nexus Manager): orquestração hierárquica | `src/graph/graph.ts` | Supervisor coordenando especialistas |
| 213440 | Projeto integrador (Nexus Manager): delegação e relatório | `src/graph/nodes/reporter-node.ts` | Relator que só redige a partir de fatos calculados |
| 213441 | Projeto integrador (Nexus Manager): relatório de valor e ROI | `src/domain/metrics/incident-metrics.ts`, `src/domain/report/numeric-guard.ts` | MTTR de dados; ROI só como faixa ilustrativa; guarda numérico |
| 213487 | Série o que fazer com IA em DevOps (213487 a 213489) | `docs/architecture.md` | Arquitetura documentada para quem avalia o projeto |
| 213488 | Série o que fazer com IA em DevOps | `fixtures/scenarios/cost-anomaly/` | Cenário FinOps com Reflection e passo proibido |
| 213489 | Série o que fazer com IA em DevOps: portfólio com incidentes reais | `docs/incidents/` | Post-mortems de falhas reais da construção |
| 213495 | Podcast sobre supply chain: automação determinística para ação destrutiva | `src/domain/autonomy/catalog.ts` | A regra decide a faixa de ação destrutiva, não o modelo |

## Padrões do módulo 06 em TypeScript

O módulo 06 usa Python e CrewAI. Este projeto reimplementa os padrões em TypeScript com LangGraph:

| No curso (Python e CrewAI) | No projeto (TypeScript e LangGraph) |
|---|---|
| `Agent(role, goal, backstory)` | Fábrica de nó (`createXNode(deps)`) e prompt versionado |
| `Crew` sequencial | Arestas fixas do `StateGraph` (planejador para auditor) |
| `manager_agent` com delegação | Nó supervisor com `SupervisorDecisionSchema` e guarda de pré-condições em código |
| Tools simuladas por condicionais | Ferramentas com parâmetros Zod sobre séries sintéticas geradas por especificação determinística |
| Runbook consultado por parâmetro de serviço | BM25 sobre seções de runbooks com frontmatter, limiar normalizado e recusa |
| Senha de aprovação no código | Token em `APPROVAL_TOKEN`, comparação em tempo constante, redação em todas as saídas |
| Aprovação "sim/não" interpretada pelo agente | Máquina de estados em código com lista fechada de termos |
| Canário que não falhava | Função pura com cenário de métricas ruins e reversão automática |
| ROI escrito pelo gerente | Funções puras de métricas, ROI como faixa ilustrativa e guarda numérico na narrativa |
| Log com hash da execução | `runId`, `requestId`, trace persistido e auditoria encadeada por hash |
