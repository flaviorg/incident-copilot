# 006: Servidor MCP

Marco M6. Estado: implementado.

## Contexto

O MCP é a segunda porta: agentes de código e assistentes (VS Code, Cursor, Inspector) podem consultar incidentes e propor remediações sobre o mesmo store da API. A regra central é que **nenhuma tool aprova nem executa**: uma proposta passa pelo mesmo caminho do portão e só roda junto com o lote, depois da decisão humana pela API.

## Escopo

- `src/mcp/server.ts`, entrypoint stdio. Redireciona `console.log`, `console.info` e `console.debug` para stderr antes de carregar a aplicação, e todo log vai para stderr em JSON.
- `create-mcp-server.ts`, com o mesmo container da API (mesmo `DB_PATH`).
- 3 tools, com `content` curto e `structuredContent` validado pelo `outputSchema`:
  - `list_incidents`;
  - `get_incident`: visão do incidente e os eventos mais recentes do trace;
  - `propose_remediation`.
- `IncidentService.proposeExternalAction`:
  - recusa campo grande demais antes de gravar (`incidentId` e `actionType` até 64 caracteres, `target` até 200, `runbookRef` até 120, `params` até 2.000 em JSON), porque o cliente MCP não se autentica;
  - só aceita incidente `awaiting_approval`;
  - classifica a ação, valida os parâmetros e roda o dry run sobre o mundo do blackboard;
  - grava tudo numa transação com versão otimista;
  - audita com o ator `mcp_client:<nome>`;
  - faixa 4, tipo desconhecido, parâmetro inválido e dry run falho viram `isError` auditado.
- `.vscode/mcp.json` (chave `servers`) e `.cursor/mcp.json` (chave `mcpServers`). Scripts `mcp` e `mcp:inspect`.

## Non-goals

- Tool de aprovação ou de execução, por construção.
- Resource `incident-copilot://autonomy-matrix` e prompt `triage-incident` (backlog v2).
- Transporte HTTP ou SSE: só stdio.
- Publicação do servidor no npm.
- Autenticação do cliente MCP: o processo roda localmente, com as permissões de quem o inicia.

## Critérios de aceite (EARS)

- **AC-34** O servidor MCP deve escrever no stdout apenas mensagens JSON-RPC; todo log vai para stderr.
- **AC-35** Quando `propose_remediation` receber ação de faixa 2 ou 3 para um incidente `awaiting_approval`, o servidor deve gravá-la como `ready` ou com aprovação `pending` (devolvendo `approvalId`), com `proposedBy: "mcp_client"` e `planRevision: null`, sem executar nada; para incidente em outro estado, deve devolver `isError`.
- **AC-36** Quando `propose_remediation` receber ação de faixa 4 ou desconhecida, o servidor deve devolver `isError: true` com motivo curto, sem detalhe interno, e auditar o bloqueio.
- **AC-37** O servidor MCP e a API devem usar o mesmo store: um incidente criado pela API deve aparecer em `list_incidents`.

## Como verificar

| Critério | Testes |
|---|---|
| AC-34 | `tests/e2e/mcp.e2e.test.ts` ("stdout carries only JSON-RPC; logs go to stderr"), com processo cru |
| AC-35 | `tests/e2e/mcp.e2e.test.ts` ("tier 2 becomes ready, tier 3 creates an approval, nothing executes", "incidents not awaiting approval reject proposals", "MCP proposals run together with the batch on the human decision") |
| AC-36 | `tests/e2e/mcp.e2e.test.ts` ("forbidden and unknown types are short isError results and are audited") |
| AC-37 | `tests/e2e/mcp.e2e.test.ts` ("same store as the API: incident created over HTTP shows up") |

Os testes usam o `Client` do SDK com `StdioClientTransport` (`tests/helpers/mcp-client.ts`) e sobem o servidor com `--import ./tests/setup/no-network.ts`.

## Referência

Documento de design do incident-copilot, revisão 2, de 2026-10-04. Ele fica no repositório do curso, fora deste repositório. Seções:

- "5.4 Tools do servidor MCP";
- "6.1 Taxonomia de erros";
- "8.3 Critérios de aceite em EARS".

A validação de entrada do SDK e a forma da mensagem de erro estão em `docs/api-notes.md`.
