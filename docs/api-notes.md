# Verified API notes

Signatures read from the `.d.ts` files in `node_modules` (not from memory or tutorials), at the versions pinned in `package.json`. The behaviors the code relies on are turned into tests in `tests/unit/api-assumptions.unit.test.ts`.

Versions: `@langchain/langgraph` 1.4.19, `@langchain/core` 1.2.14, `@langchain/openai` 1.6.2, `@modelcontextprotocol/sdk` 1.32.0, `zod` 4.6.5, `fastify` 5.12.5, `typescript` 7.0.2, `@types/node` 24.19.1, Node 24.21.0.

| Item | Where | Confirmed signature | Checked on |
|---|---|---|---|
| `StateGraph` | `@langchain/langgraph/dist/graph/state.d.ts` | `constructor(state: SD extends StateDefinitionInit ? SD : never, options?)`; accepts a Zod 4 object | 2026-10-04 |
| `addConditionalEdges` | `dist/graph/graph.d.ts` | `addConditionalEdges(source: N, path: RunnableLike<RunInput, BranchPathReturnValue, ...>, pathMap?): this` | 2026-10-04 |
| Node name | runtime | `addNode` throws "X is already being used as a state attribute (a.k.a. a channel), cannot also be used as a node name" when the node name is a state key. `supervisor` and `escalation` are blackboard keys, so the nodes are named `supervisor_agent` and `escalation_node` (`GRAPH_NODE_ID` in `src/graph/routing.ts`) | 2026-10-04 |
| Abort mid-stream | runtime | with `signal`, `stream` rejects as soon as the signal aborts (`TimeoutError`), without waiting for the running node; that node keeps running in the background and its result is discarded | 2026-10-04 |
| `GraphRecursionError` | `dist/index.d.ts` | exported from the package root | 2026-10-04 |
| Run config | `@langchain/core` `RunnableConfig` | `recursionLimit?: number`, `signal?: AbortSignal`, `configurable?: Record<string, unknown>` | 2026-10-04 |
| `stream` | runtime | `streamMode: "values"` emits the initial state and the state after each superstep; the last chunk remains available when it throws `GraphRecursionError` | 2026-10-04 |
| Subgraph in a node | runtime | inherits the parent's `recursionLimit` without passing `config`: ReAct think/act with 12 actions (25 supersteps, ending on a `think`) exceeds 25; with the parent at 100, it finishes | 2026-10-04 |
| Abort | runtime | `AbortSignal.timeout(n)` rejects with a `DOMException` where `name === "TimeoutError"` | 2026-10-04 |
| `registerTool` | `@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts` | `registerTool<OutputArgs extends ZodRawShapeCompat \| AnySchema, InputArgs extends undefined \| ZodRawShapeCompat \| AnySchema = undefined>(name, { title?, description?, inputSchema?, outputSchema?, annotations?, _meta? }, cb: ToolCallback<InputArgs>): RegisteredTool` | 2026-10-04 |
| MCP client | `dist/esm/server/index.d.ts` | `server.server.getClientVersion(): Implementation \| undefined` | 2026-10-04 |
| `StdioClientTransport` | `dist/esm/client/stdio.d.ts` | `{ command: string; args?: string[]; env?: Record<string, string>; stderr?: IOType \| Stream \| number; cwd?: string }`; without `env` it uses `getDefaultEnvironment()` | 2026-10-04 |
| `withStructuredOutput` | `@langchain/openai/dist/chat_models/base.d.ts` | `withStructuredOutput(schema, { method?: "functionCalling" \| "jsonMode" \| "jsonSchema", includeRaw?: boolean })`; with `includeRaw` it returns `{ raw, parsed }`, usage in `raw.usage_metadata` | 2026-10-04 |
| `ChatOpenAI` | same | `configuration?: ClientOptions` (takes `baseURL`), `apiKey?`, `timeout?`, `maxRetries?` (use 0) | 2026-10-04 |
| Fastify | `fastify/fastify.d.ts`, `types/instance.d.ts` | `bodyLimit?: number`, `requestIdHeader?: string \| false`, `genReqId?: (req) => string`; `inject(opts): Promise<LightMyRequestResponse>`; `setErrorHandler` | 2026-10-04 |
| `node:sqlite` | runtime | `DatabaseSync`: `prepare`, `exec`, `close`; no `transaction()`; `run()` returns `{ changes, lastInsertRowid }`; no `ExperimentalWarning` on Node 24.21 | 2026-10-04 |
| Zod | runtime | `z.toJSONSchema`, `z.iso.datetime()`, `.describe()` | 2026-10-04 |
| TypeScript | `npx tsc --version` | `Version 7.0.2`; `tsc --noEmit` runs clean with the `tsconfig.json` options and reports type errors normally | 2026-10-04 |

## Installation notes

- `npm ls zod`: a single version, `zod@4.6.5` (the rest `deduped`).
- npm did not ask for `install-scripts` approval for any backend package.
- `npm pkg set private=true` writes the string `"true"`; `npm pkg set private=true --json` was needed for the boolean.

## Block 4 checks (HTTP API, MCP, and War Room)

| Item | Where | Confirmed behavior | Checked on |
|---|---|---|---|
| Fastify `genReqId` | `fastify/fastify.d.ts` | `genReqId?: (req: RawRequestDefaultExpression) => string`; with `requestIdHeader: false`, the id comes only from `genReqId` (which reads and validates `x-request-id`) | 2026-10-04 |
| Fastify body errors | `fastify/lib/errors.js` | `FST_ERR_CTP_BODY_TOO_LARGE` (413), `FST_ERR_CTP_INVALID_JSON_BODY` and `FST_ERR_CTP_EMPTY_JSON_BODY` (400), `FST_ERR_CTP_INVALID_MEDIA_TYPE` (415); all with `code` and `statusCode` | 2026-10-04 |
| Fastify `onSend` | runtime | also runs on error responses and on `setNotFoundHandler`; with `reply.send(object)` the payload arrives already serialized (string), so redaction in `onSend` covers the whole body | 2026-10-04 |
| MCP input validation | `@modelcontextprotocol/sdk/dist/esm/server/mcp.js` | the SDK validates `inputSchema` before the handler; a failure becomes `{ isError: true, content: [{ text: "MCP error -32602: Input validation error: ... at <field>" }] }` (no stack); `createToolError` is private | 2026-10-04 |
| MCP output validation | same | `structuredContent` is validated against `outputSchema` only when `isError` is not `true` | 2026-10-04 |
| `StdioClientTransport.close()` | `dist/esm/client/stdio.js` | closes the child's stdin, waits up to 2 s, and only then sends SIGTERM; the server exits on its own when it sees stdin end | 2026-10-04 |
| `LATEST_PROTOCOL_VERSION` | `dist/esm/types.js` | `2025-11-25`; the raw test sends `2025-06-18` in `initialize` and the server accepts it | 2026-10-04 |
| `--env-file-if-exists` | runtime | the ".env not found" warning goes to stderr; the MCP server's stdout stays empty | 2026-10-04 |
| `npm run mcp` and stdout | npm 11.19.0, runtime | without `-s`, npm writes the `> incident-copilot@0.1.0 mcp` header and the command line (82 bytes) to stdout before the JSON-RPC; `npm run -s mcp` and `node --env-file-if-exists=.env src/mcp/server.ts` leave stdout empty. The `.vscode` and `.cursor` configs call `node` directly | 2026-10-04 (block 4 retry) |
| Web: `@testing-library/react` 16.3.3 | `npm view` | `@testing-library/dom` ^10 is a required peer; pinned to 10.4.2 in `web/package.json` | 2026-10-04 |
| Web: Vite 8.3.2, Vitest 5.0.3, `@vitejs/plugin-react` 6.1.1 | install and build | work together (no need for spec plan B R7); no web package needs an install script (the npm warning about `fsevents` is in the block 5 section) | 2026-10-04 |
| Web: CSS in Vitest | runtime | without `test.css: true`, Vitest replaces every `.css` (including `?raw`) with an empty string | 2026-10-04 |
| Pages actions | official GitHub releases | `actions/checkout` v7, `actions/setup-node` v7, `actions/upload-pages-artifact` v5, `actions/deploy-pages` v5 | 2026-10-04 |

## Block 5 checks (finishing)

| Item | Where | Confirmed behavior | Checked on |
|---|---|---|---|
| CI actions | official GitHub releases (public `releases/latest` API) | `actions/checkout` v7.0.1 and `actions/setup-node` v7.0.0; `ci.yml` uses `@v7` for both, like `pages.yml` | 2026-10-04 |
| `node --test` with an explicit glob | runtime (Node 24.21.0) | `node --test "tests/live/**/*.live.ts"` runs files without the `.test` suffix; a test with `skip` reports `# SKIP`, counts toward `skipped`, and the process exits with code 0 | 2026-10-04 |
| `node --env-file-if-exists` in `test:live` | runtime | without `.env`, the ".env not found" warning goes to stderr and the test is skipped (no `OPENROUTER_API_KEY`) | 2026-10-04 |
| Glob with no match in zsh | default macOS shell | `rm -rf ... data/*.db` with no `.db` files fails with "no matches found" and zsh does not run the command at all. The from-scratch check ran in `bash` with `shopt -s nullglob` | 2026-10-04 |
| `npm ci` with a warm cache | npm 11.19.0 | 164 packages at the root and 100 in `web/`, each in 1 to 2 s | 2026-10-04 |
| `install-scripts` warning on `npm --prefix web ci` | npm 11.19.0, `web/package-lock.json` | with `node_modules` deleted, npm warns "1 package has install scripts not yet covered by allowScripts: fsevents@2.3.3" and runs nothing. `fsevents` is an optional Vite dependency, macOS only. The lockfile marks it `hasInstallScript: true`, but the published package has no `install` script or `binding.gyp` and ships a prebuilt `fsevents.node`. The web build and tests pass without approving the script, so `allowScripts` was left alone. The root has no warning | 2026-10-04 (block 5 retry) |
