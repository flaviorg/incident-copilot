# Notas de falhas reais durante a construção

Matéria-prima dos post-mortems (Tarefa 42). Só fatos que aconteceram, com data, sintoma e causa.

## 2026-10-04: teste de herança do `recursionLimit` passou sem lançar

- **Sintoma:** em `api-assumptions.unit.test.ts`, o subgrafo think/act com 12 ações dentro de um nó não lançou `GraphRecursionError` com o pai em 25.
- **Causa:** a topologia do teste terminava no nó `act` (12 think + 12 act = 24 supersteps), um a menos que o limite. Um ReAct real termina num `think` que emite a resposta final (25 supersteps), e aí estoura.
- **Correção:** `think` decide entre ação e fim; o teste também afirma que, com o pai em 100, o mesmo subgrafo termina, o que prova herança e não só o padrão de 25.

## 2026-10-04: nó do grafo com o mesmo nome de uma chave do estado

- **Sintoma:** o plano (Tarefa 22) nomeava os nós do grafo com os `AgentId` (`supervisor`, `escalation`). Uma sondagem antes de escrever o `graph.ts` mostrou que o `addNode("supervisor", ...)` lança "supervisor is already being used as a state attribute (a.k.a. a channel), cannot also be used as a node name".
- **Causa:** o LangGraph usa o mesmo espaço de nomes para canais do estado e nós, e `supervisor` e `escalation` são chaves do `BlackboardSchema`, que é contrato do spec 5.2 e não muda.
- **Correção:** as rotas continuam devolvendo o nome lógico (`NodeName`); `GRAPH_NODE_ID` em `src/graph/routing.ts` dá o id registrado (`supervisor_agent`, `escalation_node`) e o `pathMap` de cada aresta faz a tradução. Um teste em `api-assumptions.unit.test.ts` e outro em `routing.unit.test.ts` travam o comportamento.

## 2026-10-04: modo estrito do fake conferia o roteiro de todos os cenários

- **Sintoma:** no primeiro verde da Tarefa 22, `c.fake.assertAllConsumed()` no teste do cenário de deploy falhou listando os turnos do `cost-anomaly` (e vice-versa).
- **Causa:** o container de teste carrega as fixtures de todos os cenários, e `assertAllConsumed` percorria todos os arquivos.
- **Correção:** opção `scenarioId` em `assertAllConsumed`, que confere só o roteiro do cenário executado; teste novo em `fake-provider.unit.test.ts`.

## 2026-10-04: o caso "dry run falho" do plano não passava pelo auditor

- **Sintoma:** o plano (Tarefa 29, e spec 7.4) pede um teste de ponta a ponta com `patchFixture` trocando o rollback para `v9.9.9` e espera `[succeeded, rejected_by_dry_run, cancelled]`, sem aprovação. Lendo a regra `rollback_requires_recent_deploy` antes de escrever o teste, ficou claro que o auditor reprova esse plano: `toVersion` precisa ser a versão anterior ao deploy suspeito (`v3.7.2`). O fake pediria `plan-1`, que não existe, e o teste quebraria com `UnscriptedLlmCallError`.
- **Causa:** as regras do auditor espelham as checagens do dry run (alvo existe, versão no histórico), então nenhum passo de faixa 3 do catálogo falha no dry run e passa no auditor com os dados do cenário. Foi um descuido do plano, não da biblioteca.
- **Correção:** o caso puro (dry run falho sem aprovação, dependente cancelado) ficou no teste do nó (`nodes-gate.unit.test.ts`, com o estado montado depois do auditor). No teste de ponta a ponta, a fixture roteiriza as revisões 1 e 2 com o mesmo plano; esgotadas as revisões, todos os passos sobem para faixa 3, o rollback termina `rejected_by_dry_run` sem aprovação, o dependente é cancelado e só a nota pede aprovação. Aprovada a nota, o incidente escala com `no_executable_actions`.

## 2026-10-04: teste da ordem de reversão olhava a ordem errada

- **Sintoma:** no primeiro verde da Tarefa 28, o teste do canário reprovado falhou: esperava `["block_image_tag", "rollback_deployment"]` e recebeu `["rollback_deployment", "block_image_tag"]`.
- **Causa:** o teste (copiado do texto do plano) filtrava `actions` por `reverted`, e `filter` preserva a ordem do plano. A reversão em si estava certa, em ordem inversa de `executedAt`.
- **Correção:** a ordem da reversão é afirmada pelos eventos `revert:<tipo>` do verificador no trace e por `verification.revertedActionIds`.

## 2026-10-04: segundo incidente do mesmo cenário na API respondia 500

- **Sintoma:** no teste da Tarefa 33 que abre dois incidentes `deploy-5xx-rollback` no mesmo `buildServer`, o segundo `POST /incidents` respondeu 500. O log trazia `UnscriptedLlmCallError` no `supervisor.v1`, "turnos deste prompt 4/5 consumidos".
- **Causa:** o `FakeLlmProvider` marcava os turnos como consumidos por processo. A CLI e os testes sempre abriam um incidente por container, então ninguém tinha visto. Mas a API e o servidor MCP são processos de longa duração: com o fake, o segundo incidente de um cenário encontrava o roteiro gasto pelo primeiro.
- **Correção:** a correspondência (spec 7.2, regra 2) passou a olhar os turnos consumidos pelo próprio incidente (`ctx.incidentId`), então cada incidente toca o roteiro do começo. O modo estrito continua olhando a união (turno consumido por algum incidente). Teste novo em `fake-provider.unit.test.ts`; o teste HTTP abre o segundo incidente no mesmo processo.

## 2026-10-04: teste de contraste lia o tokens.css vazio

- **Sintoma:** na Tarefa 38, o teste de contraste dos tokens falhou com "token --color-text ausente no tema light", embora o token estivesse no arquivo.
- **Causa:** o teste importava `../styles/tokens.css?raw`, para não depender de tipos do Node no pacote `web`. Por padrão, o Vitest troca todo arquivo CSS por string vazia, inclusive com `?raw`. Uma asserção de diagnóstico mostrou o tamanho 0.
- **Correção:** `test.css: true` no `web/vite.config.ts`. O teste passou a ler o arquivo real. Registrado em `docs/api-notes.md`.

## 2026-10-04: foco do teclado se perdia no portão e no fim da reprodução

- **Sintoma:** na conferência manual da Tarefa 41, só com teclado, a 1280 px, o foco ia para o `body` quando a reprodução chegava ao portão. O botão Avançar, que estava focado, fica desabilitado nesse ponto. Quem usa leitor de tela perdia o lugar e tinha de voltar ao começo com Tab.
- **Causa:** um botão desabilitado perde o foco, e nenhum código o movia para outro lugar. Os testes automáticos clicavam nos botões e não percebiam.
- **Correção:**
  - Ao carregar uma gravação ou escolher um ramo, o foco vai para Avançar.
  - No portão, vai para o título "Portão de aprovação", e o próximo Tab chega em Aprovar.
  - No fim, vai para o título do post-mortem.
  - Teste novo em `web/src/test/App.test.tsx`, escrito antes da correção e visto falhando.

## 2026-10-04: comando de limpeza do plano não rodava no zsh

- **Sintoma:** na Tarefa 47, o passo "limpar e instalar do lockfile" (`rm -rf node_modules ... data/*.db data/*.db-* && time (...)`) parou na hora com `no matches found: data/*.db`. Nada foi apagado nem instalado.
- **Causa:** o zsh, shell padrão do macOS, trata glob sem correspondência como erro e não executa o comando. Não havia nenhum banco em `data/`. No `bash`, o glob sem correspondência passa literal e o `rm -rf` ignora.
- **Correção:** a verificação rodou em `bash` com `shopt -s nullglob`. O comando do README para o S1 não usa glob. Registrado em `docs/api-notes.md`.

## 2026-10-04: `npm run mcp` não deixava o stdout vazio

- **Sintoma:** na nova tentativa do bloco 4, `npm run mcp < /dev/null` escreveu 82 bytes no stdout: o cabeçalho `> incident-copilot@0.1.0 mcp` e a linha do comando, que não são JSON-RPC. O log do bloco 4 e o README diziam que o stdout ficava vazio, ou que só levava JSON-RPC.
- **Causa:** o cabeçalho é do npm 11.19.0, não do servidor. A conferência anterior olhou o processo `node`, cujo stdout de fato fica vazio, e estendeu a conclusão ao script do npm. O teste de AC-34 sobe o `node` cru, então não pega o cabeçalho. Um cliente MCP configurado com `npm run mcp` receberia duas linhas que não são JSON-RPC antes do `initialize`.
- **Correção:** só de documentação, porque o script segue o spec 8.4 e as configurações `.vscode` e `.cursor` já chamam `node` direto. O README e `docs/api-notes.md` agora indicam `node` direto ou `npm run -s mcp`, cujo stdout foi conferido vazio.

## 2026-10-04: as notas de API diziam que nenhum pacote da web pedia script de instalação

- **Sintoma:** na nova tentativa do bloco 5, o passo 1 da Tarefa 47 (apagar `node_modules` e `web/node_modules`, depois `npm ci && npm --prefix web ci && npm run verify`) terminou com código 0. Mas o `npm --prefix web ci` avisou "1 package has install scripts not yet covered by allowScripts: fsevents@2.3.3". `docs/api-notes.md` dizia, nos blocos 4 e 5, que nenhum pacote da web pedia script de instalação.
- **Causa:** o `fsevents` é dependência opcional do Vite, só no macOS, e o `web/package-lock.json` o marca com `hasInstallScript: true`. O pacote publicado não tem script `install` nem `binding.gyp` e já traz o `fsevents.node` compilado, então não há nada para rodar e o build funciona. Não ficou registrado por que as conferências anteriores não viram o aviso. Nesta execução, ele aparece logo depois do resumo do `npm --prefix web ci`, antes da saída do `verify`.
- **Correção:** só de documentação. `docs/api-notes.md` descreve o aviso e por que ele é inofensivo. O `allowScripts` não foi mexido, e o script não foi aprovado.

## 2026-10-04: decisão aceita durante a execução de abertura deixava o incidente inconsistente

- **Sintoma:** na revisão final, uma sonda com o portão real seguido de uma pausa de 150 ms viu `APR-0001` pendente em `GET /approvals` enquanto o `POST /incidents` ainda rodava. A decisão nessa janela respondeu 200, e o `POST /incidents` respondeu 409 `version_conflict`. O incidente ficou `open`, com blackboard sem ações, 3 linhas em `actions`, aprovação `approved`, auditoria dizendo executado e escalado, e a linha de `runs` sem desfecho. Nenhuma chamada da API recuperava.
- **Causa:** o portão grava aprovações, ações e auditoria no meio da execução, mas o blackboard só é gravado no fim, com versão otimista. A decisão mudava o blackboard por baixo da execução, e o roteamento depois do portão lia zero pendências e mandava o lote ao executor dentro da abertura. Sem a pausa, a janela é menor que um segundo (portão, fim do grafo, gravação), por isso o teste de decisões concorrentes não a pegava. Além disso, `run()` só fechava a linha de `runs` depois da gravação final.
- **Correção:** `applyDecision` e `expireDueApprovals` recusam com 409 `incident_not_accepting`, sem gravar nada, quando o incidente tem linha de `runs` sem fim. `run()` fecha a linha de `runs` também quando a gravação final lança. Dois testes novos em `tests/e2e/gate.e2e.test.ts`, com o portão real seguido de um gancho no mesmo superstep, escritos antes da correção e vistos falhando.

## 2026-10-04: `check:secrets` quebrava o pre-commit de quem seguia o README

- **Sintoma:** na revisão final, com um `.env` preenchido como manda "Usando um modelo real", `npm run check:secrets`, o pre-commit e `npm run verify` saíram com código 1 (`.env:1` e `.env:3`).
- **Causa:** a varredura percorre a árvore sem `git ls-files` (a pasta vive dentro do repositório do curso) e ignorava `reports`, `web/dist`, `web/public/demo`, `coverage` e `data/*.db`, mas não o `.env`, que está no `.gitignore`. Os testes rodavam numa árvore sem `.env`.
- **Correção:** o `.env` local fica fora da varredura enquanto o Git não o rastreia (`git ls-files --error-unmatch`); rastreado, volta a ser varrido. `.env.example` continua varrido. Dois testes novos em `tests/unit/check-secrets.unit.test.ts`, vistos falhando antes.
