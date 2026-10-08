# Notas de API conferidas

Assinaturas lidas nos `.d.ts` de `node_modules` (não na memória nem em tutoriais), com as versões fixadas no `package.json`. Os comportamentos de que o código depende viram testes em `tests/unit/api-assumptions.unit.test.ts`.

Versões: `@langchain/langgraph` 1.4.19, `@langchain/core` 1.2.14, `@langchain/openai` 1.6.2, `@modelcontextprotocol/sdk` 1.32.0, `zod` 4.6.5, `fastify` 5.12.5, `typescript` 7.0.2, `@types/node` 24.19.1, Node 24.21.0.

| Item | Onde | Assinatura confirmada | Conferido em |
|---|---|---|---|
| `StateGraph` | `@langchain/langgraph/dist/graph/state.d.ts` | `constructor(state: SD extends StateDefinitionInit ? SD : never, options?)`; aceita objeto Zod 4 | 2026-10-04 |
| `addConditionalEdges` | `dist/graph/graph.d.ts` | `addConditionalEdges(source: N, path: RunnableLike<RunInput, BranchPathReturnValue, ...>, pathMap?): this` | 2026-10-04 |
| Nome de nó | runtime | `addNode` lança "X is already being used as a state attribute (a.k.a. a channel), cannot also be used as a node name" quando o nome do nó é uma chave do estado. `supervisor` e `escalation` são chaves do blackboard, então os nós se chamam `supervisor_agent` e `escalation_node` (`GRAPH_NODE_ID` em `src/graph/routing.ts`) | 2026-10-04 |
| Aborto no meio do stream | runtime | com `signal`, o `stream` rejeita assim que o sinal aborta (`TimeoutError`), sem esperar o nó em andamento; o nó segue rodando em segundo plano e o resultado dele é descartado | 2026-10-04 |
| `GraphRecursionError` | `dist/index.d.ts` | exportado pela raiz do pacote | 2026-10-04 |
| Config de execução | `@langchain/core` `RunnableConfig` | `recursionLimit?: number`, `signal?: AbortSignal`, `configurable?: Record<string, unknown>` | 2026-10-04 |
| `stream` | runtime | `streamMode: "values"` emite o estado inicial e o estado após cada superstep; o último chunk segue disponível quando lança `GraphRecursionError` | 2026-10-04 |
| Subgrafo em nó | runtime | herda o `recursionLimit` do pai sem repassar `config`: ReAct think/act com 12 ações (25 supersteps, terminando num `think`) estoura 25; com o pai em 100, termina | 2026-10-04 |
| Aborto | runtime | `AbortSignal.timeout(n)` rejeita com `DOMException` `name === "TimeoutError"` | 2026-10-04 |
| `registerTool` | `@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts` | `registerTool<OutputArgs extends ZodRawShapeCompat \| AnySchema, InputArgs extends undefined \| ZodRawShapeCompat \| AnySchema = undefined>(name, { title?, description?, inputSchema?, outputSchema?, annotations?, _meta? }, cb: ToolCallback<InputArgs>): RegisteredTool` | 2026-10-04 |
| Cliente MCP | `dist/esm/server/index.d.ts` | `server.server.getClientVersion(): Implementation \| undefined` | 2026-10-04 |
| `StdioClientTransport` | `dist/esm/client/stdio.d.ts` | `{ command: string; args?: string[]; env?: Record<string, string>; stderr?: IOType \| Stream \| number; cwd?: string }`; sem `env` usa `getDefaultEnvironment()` | 2026-10-04 |
| `withStructuredOutput` | `@langchain/openai/dist/chat_models/base.d.ts` | `withStructuredOutput(schema, { method?: "functionCalling" \| "jsonMode" \| "jsonSchema", includeRaw?: boolean })`; com `includeRaw` devolve `{ raw, parsed }`, uso em `raw.usage_metadata` | 2026-10-04 |
| `ChatOpenAI` | idem | `configuration?: ClientOptions` (recebe `baseURL`), `apiKey?`, `timeout?`, `maxRetries?` (usar 0) | 2026-10-04 |
| Fastify | `fastify/fastify.d.ts`, `types/instance.d.ts` | `bodyLimit?: number`, `requestIdHeader?: string \| false`, `genReqId?: (req) => string`; `inject(opts): Promise<LightMyRequestResponse>`; `setErrorHandler` | 2026-10-04 |
| `node:sqlite` | runtime | `DatabaseSync`: `prepare`, `exec`, `close`; sem `transaction()`; `run()` devolve `{ changes, lastInsertRowid }`; sem `ExperimentalWarning` no Node 24.21 | 2026-10-04 |
| Zod | runtime | `z.toJSONSchema`, `z.iso.datetime()`, `.describe()` | 2026-10-04 |
| TypeScript | `npx tsc --version` | `Version 7.0.2`; `tsc --noEmit` roda limpo com as opções do `tsconfig.json` e reporta erros de tipo normalmente | 2026-10-04 |

## Observações da instalação

- `npm ls zod`: uma única versão, `zod@4.6.5` (as demais `deduped`).
- O npm não pediu aprovação de `install-scripts` para nenhum pacote do backend.
- `npm pkg set private=true` grava a string `"true"`; foi preciso `npm pkg set private=true --json` para o booleano.

## Conferências do bloco 4 (API HTTP, MCP e War Room)

| Item | Onde | Comportamento confirmado | Conferido em |
|---|---|---|---|
| Fastify `genReqId` | `fastify/fastify.d.ts` | `genReqId?: (req: RawRequestDefaultExpression) => string`; com `requestIdHeader: false`, o id vem só do `genReqId` (que lê `x-request-id` e valida) | 2026-10-04 |
| Fastify erros de corpo | `fastify/lib/errors.js` | `FST_ERR_CTP_BODY_TOO_LARGE` (413), `FST_ERR_CTP_INVALID_JSON_BODY` e `FST_ERR_CTP_EMPTY_JSON_BODY` (400), `FST_ERR_CTP_INVALID_MEDIA_TYPE` (415); todos com `code` e `statusCode` | 2026-10-04 |
| Fastify `onSend` | runtime | roda também nas respostas de erro e do `setNotFoundHandler`; com `reply.send(objeto)` o payload já chega serializado (string), então a redação no `onSend` cobre o corpo inteiro | 2026-10-04 |
| MCP validação de entrada | `@modelcontextprotocol/sdk/dist/esm/server/mcp.js` | o SDK valida o `inputSchema` antes do handler; falha vira `{ isError: true, content: [{ text: "MCP error -32602: Input validation error: ... at <campo>" }] }` (sem stack); `createToolError` é privado | 2026-10-04 |
| MCP validação de saída | idem | `structuredContent` é validado contra o `outputSchema` só quando `isError` não é `true` | 2026-10-04 |
| `StdioClientTransport.close()` | `dist/esm/client/stdio.js` | fecha o stdin do filho, espera até 2 s e só então manda SIGTERM; o servidor encerra sozinho ao ver o fim do stdin | 2026-10-04 |
| `LATEST_PROTOCOL_VERSION` | `dist/esm/types.js` | `2025-11-25`; o teste cru manda `2025-06-18` no `initialize` e o servidor aceita | 2026-10-04 |
| `--env-file-if-exists` | runtime | o aviso ".env not found" vai para stderr; o stdout do servidor MCP fica vazio | 2026-10-04 |
| `npm run mcp` e o stdout | npm 11.19.0, runtime | sem `-s`, o npm escreve no stdout o cabeçalho `> incident-copilot@0.1.0 mcp` e a linha do comando (82 bytes) antes do JSON-RPC; `npm run -s mcp` e `node --env-file-if-exists=.env src/mcp/server.ts` deixam o stdout vazio. As configurações `.vscode` e `.cursor` usam `node` direto | 2026-10-04 (nova tentativa do bloco 4) |
| Web: `@testing-library/react` 16.3.3 | `npm view` | `@testing-library/dom` ^10 é peer obrigatória; fixada em 10.4.2 no `web/package.json` | 2026-10-04 |
| Web: Vite 8.3.2, Vitest 5.0.3, `@vitejs/plugin-react` 6.1.1 | instalação e build | funcionam juntos (sem plano B do spec R7); nenhum pacote da web precisa de script de instalação (o aviso do npm sobre o `fsevents` está na seção do bloco 5) | 2026-10-04 |
| Web: CSS no Vitest | runtime | sem `test.css: true`, o Vitest troca todo `.css` (inclusive `?raw`) por string vazia | 2026-10-04 |
| Actions do Pages | releases oficiais no GitHub | `actions/checkout` v7, `actions/setup-node` v7, `actions/upload-pages-artifact` v5, `actions/deploy-pages` v5 | 2026-10-04 |

## Conferências do bloco 5 (acabamento)

| Item | Onde | Comportamento confirmado | Conferido em |
|---|---|---|---|
| Actions do CI | releases oficiais no GitHub (API pública `releases/latest`) | `actions/checkout` v7.0.1 e `actions/setup-node` v7.0.0; `ci.yml` usa `@v7` nas duas, como o `pages.yml` | 2026-10-04 |
| `node --test` com glob explícito | runtime (Node 24.21.0) | `node --test "tests/live/**/*.live.ts"` roda arquivos sem o sufixo `.test`; teste com `skip` sai como `# SKIP`, conta em `skipped` e o processo termina com código 0 | 2026-10-04 |
| `node --env-file-if-exists` no `test:live` | runtime | sem `.env`, o aviso ".env not found" vai para stderr e o teste é pulado (sem `OPENROUTER_API_KEY`) | 2026-10-04 |
| Glob sem correspondência no zsh | shell padrão do macOS | `rm -rf ... data/*.db` sem nenhum `.db` falha com "no matches found" e o zsh não executa o comando inteiro. A verificação do zero rodou em `bash` com `shopt -s nullglob` | 2026-10-04 |
| `npm ci` com cache aquecido | npm 11.19.0 | 164 pacotes na raiz e 100 em `web/`, cada um em 1 a 2 s | 2026-10-04 |
| Aviso de `install-scripts` no `npm --prefix web ci` | npm 11.19.0, `web/package-lock.json` | com `node_modules` apagado, o npm avisa "1 package has install scripts not yet covered by allowScripts: fsevents@2.3.3" e não roda nada. O `fsevents` é dependência opcional do Vite, só no macOS. O lockfile o marca com `hasInstallScript: true`, mas o pacote publicado não tem script `install` nem `binding.gyp` e já traz o `fsevents.node` compilado. O build e os testes da web passam sem aprovar o script, então o `allowScripts` não foi mexido. A raiz não tem aviso | 2026-10-04 (nova tentativa do bloco 5) |
