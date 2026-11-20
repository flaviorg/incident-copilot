# MCP data source

Type `mcp`. A generic, **query-only** connector: it connects to any [MCP](https://modelcontextprotocol.io) server and
lets the investigation call an allowlist of that server's **read-only** tools through `query_external`. Use it when a
provider has an MCP server but no dedicated connector, or to reach a tool a dedicated connector does not cover (an
NRQL query, a runbook search, an internal service).

It cannot open incidents: there is no ingest side. Pair it with an ingest connector (Alertmanager, Sentry, ...).

What the model sees is decided by you, not by the server:

- only the tools you list under `tools` are visible or callable;
- a listed tool that the server marks `destructiveHint: true` or `readOnlyHint: false` is refused and logged as a
  warning with the tool name only;
- the model **never writes an argument**: you declare each tool's `arguments`, and the model only fills the
  `{service}` and `{window}` placeholders you put in them, each value checked against a strict allowlist (see
  "Tool arguments"). A tool without `arguments` takes none;
- the model sees the description **you** write; the server's own description is used only when you write none, and
  then only after sanitizing;
- results are text only, sanitized, clipped and shown to the model as an untrusted observation. They never choose a
  tier, an approval or an execution (spec 008, AC-50 and AC-58).

## 1. Choose the transport

| Transport | Use when | Needs |
|---|---|---|
| `http` | The server is hosted (Streamable HTTP endpoint) and accepts a static key in a header | `url`; `secretHeaders` and `headers` as the server requires |
| `stdio` | The server is a program the copilot starts and talks to over stdin and stdout | `command` (an absolute path or a bare name on `PATH`), `args`, `env` |

The `http` transport uses the injected `fetch` of the copilot, so it honors the same proxy and test seams as every
connector. Plain `http://` is accepted only for `localhost`, `127.0.0.1` and `[::1]`. Redirects stay within the same
origin (the SDK default); a URL that redirects elsewhere fails as `unavailable`.

**OAuth is not supported in 0.4.** A server that accepts only OAuth cannot be used, and the connection fails as
`authentication failed`. The Sentry hosted MCP server (`https://mcp.sentry.dev/mcp`) is one of them; use the dedicated
`sentry` connector (API token) for Sentry.

The `stdio` child gets only the SDK's small default environment (such as `PATH` and `HOME`) plus the `env` you list.
Its stderr is discarded. The process starts on the first call, is reused, and is stopped when the copilot shuts down.

## 2. Allowlist only read-only tools

List each tool the model may call under `tools`, by its exact name. Start with the smallest set that answers your
on-call questions. Read the server's tool reference first, and prefer tools that only read.

The server's annotations are hints from a party you do not control. They can only **remove** a tool from your list;
they never add one. A tool without annotations is allowed when you list it, so the allowlist, not the server, is the
safety control. Never list a tool that creates, changes or deletes anything, even if the server calls it read-only.

Each tool takes `maxResultChars` (200 to 8000, default 4000): the largest result text kept. At most 20 tools; names
are unique.

## 3. Write the descriptions yourself

Server descriptions are text written by someone else that goes into the model's prompt. A compromised or careless
server can put instructions there. Write a short `description` (up to 500 characters) for every tool, saying what it
reads and the syntax it expects. When you omit it, the server's text is used, sanitized and clipped to 1,000
characters; the tool's input schema is always the server's, with `<<<` and `>>>` neutralized and clipped to 2,000
characters of JSON.

## 4. Configure and run `config check`

Secrets go only in `secretHeaders` (HTTP) and `env` (stdio), each a whole `${VAR}` reference to a set environment
variable. Their values join the redaction list: they appear in no log, response, trace or notification. `headers` are
for values that are not secret (an `include-tags` list, say) and may use `${VAR}` inside a string.

Then validate the file without starting anything:

```sh
npm run cli -- config check
```

Each problem is reported as `{ path, rule }` with no value. `config check` does not open the connection; the first
investigation does. A wrong key shows up as `authentication failed` in the first `query_external` observation.

### Fields

| Field | Applies to | Meaning |
|---|---|---|
| `transport` | both | `http` or `stdio` |
| `url` | http, required | The MCP endpoint, https (http for loopback only), no credentials in the URL |
| `headers` | http | `[{ name, value }]`, up to 10; name 1 to 64 of letters, digits and `-` |
| `secretHeaders` | http | `{ <name>: "${VAR}" }`, values of at least 8 characters |
| `command` | stdio, required | An absolute path or a bare command name; relative paths such as `./x` are refused |
| `args` | stdio | Up to 20 strings |
| `env` | stdio | `{ NAME: "${VAR}" }` for the child |
| `tools` | both, required | 1 to 20 of `{ name, description?, maxResultChars?, arguments? }` |
| `timeoutMs` | both | 1000 to 60000, default 15000: the longest the connect, a listing or a call may take |

Headers the transport owns (`Accept`, `Content-Type`, `Content-Length`, `Host`, `Connection`, `Transfer-Encoding`,
`Mcp-Session-Id`, `Mcp-Protocol-Version`, `Last-Event-ID`) cannot be set, and a name cannot appear in both `headers`
and `secretHeaders` (case-insensitive). The entry is a strict object: unknown keys are errors.

## Example A: New Relic MCP

```yaml
connectors:
  - id: newrelic-mcp
    type: mcp
    transport: http
    url: https://mcp.newrelic.com/mcp/        # EU: https://mcp.eu.newrelic.com/mcp/   JP: https://mcp.jp.newrelic.com/mcp/
    secretHeaders:
      api-key: "${NEW_RELIC_USER_KEY}"
    headers:
      - { name: include-tags, value: "data-access,incident-response" }
    tools:
      - name: execute_nrql_query
        description: "Runs the configured NRQL for a service and a window and returns rows. Read only."
        arguments:
          query: "SELECT count(*) FROM TransactionError WHERE appName = '{service}' FACET error.class SINCE {window} ago LIMIT 10"
```

The NRQL above is yours: the model chooses only the service (it must be the incident's service or a configured one)
and the window. Add other tools the same way, with `arguments` that match the parameter names in the live schema.

Notes for New Relic (from its documentation, see "Facts and sources"):

- An administrator must enable the MCP server, and its API Keys sub-toggle, in feature control, or the key is refused.
- Usage is metered in Core Compute Units.
- Tools that need OAuth are not available with an API key and must not be allowlisted: `natural_language_to_nrql_query`,
  `analyze_deployment_impact`, `generate_alert_insights_report`, `generate_user_impact_report`,
  `analyze_github_newrelic_gaps`, `search_traces`, `analyze_trace_anomaly` and `analyze_service_dependencies`.
- Read the live schemas (see "Unverified") before you add a tool, and drop any tool that is not read only for your
  account. The server's own schema is never shown to the model: it sees one derived from your `arguments`.

The dedicated `newrelic` connector (ingest and NRQL-based queries) is the first choice for New Relic when it fits;
this one reaches the tools it does not.

## Example B: a local stdio server

```yaml
connectors:
  - id: runbook-search
    type: mcp
    transport: stdio
    command: /opt/mcp/bin/runbook-server       # or a bare name such as my-mcp-server, found on PATH
    args: ["--read-only", "--index", "/opt/mcp/runbooks"]
    env:
      RUNBOOK_API_TOKEN: "${RUNBOOK_API_TOKEN}"
    timeoutMs: 20000
    tools:
      - name: search_runbooks
        description: "Full-text search of the team runbooks for the service of the incident."
        maxResultChars: 3000
        arguments:
          query: "{service} runbook"
          limit: 5
```

The command runs with the copilot's privileges and sees the `env` you list: install it from a source you trust, and
prefer a read-only mode of the server when it has one. In Docker the command must exist inside the image.

## Tool arguments

`arguments` is a map of argument name to a string, number or boolean (up to 10 entries), written by you. In a string
value two placeholders are supported, and only these two:

| Placeholder | The model supplies | Allowed values | Substituted as |
|---|---|---|---|
| `{service}` | `service` | 1 to 120 of letters, digits, space and `. _ : / ( ) [ ] -`; no quote, backslash or control character. The tool also checks it is the incident's service or a configured one, and maps the connector alias | The value as is |
| `{window}` | `window` | `15m`, `30m`, `60m`, `24h`, `7d` | `15 minutes`, `30 minutes`, `60 minutes`, `24 hours`, `7 days` |

The model's call must carry exactly the placeholders the template uses: a missing, extra or malformed key makes the
call fail with `unsafe_input` before the server is contacted. Put `{service}` inside quotes in a query language and
review the template as you would any query you run by hand.

## How a call flows

1. The first `tools()` or `call()` opens the connection (lazily, once). Later calls reuse it; if it drops, the next
   call reconnects and lists the tools again.
2. `tools()` lists every page of `tools/list`, keeps the allowlisted names, drops the refused and the missing ones
   (a warning with the tool name only) and caches the list for the life of the connection.
3. `call(tool, args)` needs `tool` in that exposed set and `args` to be a plain object holding exactly the
   placeholders the tool's `arguments` use, with allowed values; otherwise it throws `unsafe_input` without calling
   the server. A name outside your allowlist, or an argument the model should not write, does not even open the
   connection. The server receives your `arguments` with the placeholders filled, never a model-written string.
4. The result's text items are joined with newlines. Other items (images, resources) are counted and replaced by
   `(N non-text items omitted)`. The text is sanitized (control and bidi characters removed, `<<<` and `>>>`
   neutralized) and clipped to the tool's `maxResultChars`. `structuredContent` is ignored. An answer with
   `isError: true` becomes `ok: false` with its text; an empty answer becomes `(no text content)`.
5. Failures are `ConnectorError` kinds with fixed messages, never the SDK's or the server's text:

| Cause | Kind |
|---|---|
| Aborted by the investigation, or `timeoutMs` exceeded | `timeout` |
| HTTP 401 or 403, or an OAuth challenge | `auth` |
| HTTP 429 | `rate_limited` |
| Network error, HTTP 5xx, command not found, process exit, closed connection | `unavailable` |
| A reply that is not valid JSON-RPC or fails the SDK's schema, or a JSON-RPC error from the server | `bad_response` |
| A tool that is not exposed, or arguments that are not a plain object | `unsafe_input` |

Headers, `env`, URLs, arguments and results are never logged.

## SDK API notes

Package `@modelcontextprotocol/sdk` **1.32.0** (the version pinned in `package.json`); the facts below were read from
its `.d.ts` and `.js` files in `node_modules/@modelcontextprotocol/sdk/dist/esm` while writing the connector. Imports
use the `.js` subpaths, as `src/mcp` and the test helpers do.

| API | File | What the connector relies on |
|---|---|---|
| `Client` | `client/index.js` | `new Client({ name, version }, { capabilities: {} })` |
| `client.connect(transport, options?)` | `client/index.js` | Starts the transport and sends `initialize` then `notifications/initialized`. `options` is `RequestOptions`, so `signal` and `timeout` bound the handshake. On failure it closes the client and rethrows |
| `client.listTools(params?, options?)` | `client/index.js` | `params.cursor` selects a page; the result has `tools` and `nextCursor` (absent on the last page) |
| `client.callTool(params, resultSchema?, options?)` | `client/index.js` | `params` is `{ name, arguments }`. `resultSchema` defaults to `CallToolResultSchema`; pass `undefined` to keep it. `options` is `RequestOptions` |
| `RequestOptions` | `shared/protocol.d.ts` | `signal` cancels the request (an `AbortError`); `timeout` in ms raises `McpError` with `ErrorCode.RequestTimeout` (-32001); the default timeout applies when it is unset |
| `McpError`, `ErrorCode` | `types.js` | `ConnectionClosed` is -32000, `RequestTimeout` is -32001; `McpError.code` holds a JSON-RPC error code |
| `StreamableHTTPClientTransport(url, opts)` | `client/streamableHttp.js` | `opts.requestInit` (`RequestInit`, its headers go on every request), `opts.fetch` (`FetchLike`: `(url: string \| URL, init?) => Promise<Response>`), `opts.redirectPolicy` (`'same-origin'` default), `opts.authProvider` (OAuth, unused). A non-OK reply throws `StreamableHTTPError` with the HTTP status in `code`; a 401 without `authProvider` throws `UnauthorizedError` (`client/auth.js`) |
| `StdioClientTransport(params)` | `client/stdio.js` | `params.command`, `args`, `env`, `stderr` (default `'inherit'`), `cwd`, `maxBufferSize` (10 MB). The child environment is `getDefaultEnvironment()` merged with `env`; `spawn` runs with `shell: false`. A spawn failure rejects `start()` with the `spawn` error |
| `Tool.annotations` | `types.d.ts` | `ToolAnnotations` has optional `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. The SDK states they are hints and must not drive decisions on tools from untrusted servers; here they can only remove a tool |
| `InMemoryTransport.createLinkedPair()` | `inMemory.js` | Two linked `Transport`s: one for a `Client`, one for a server. Used by the tests |
| `McpServer.registerTool(name, { description, inputSchema, annotations }, cb)` | `server/mcp.js` | `inputSchema` is a zod raw shape; `cb` returns `{ content: [...], isError?, structuredContent? }`. Used by the test server |
| `Server.setRequestHandler(ListToolsRequestSchema, ...)` | `server/index.js` | Low-level server, used by the tests to control `tools/list` (pagination) |

SDK behaviors worth knowing:

- `callTool` validates `structuredContent` against a tool's `outputSchema` when the server declares one, and rejects
  a reply that lacks it with an `McpError` (this connector reports `bad_response`).
- Closing the client closes its transport (for stdio, the child process).
- The `Client.onclose` callback fires on a dropped connection; the connector uses it to reconnect lazily.

## Facts and sources

- **MCP SDK 1.32.0**: the `.d.ts` and `.js` files named in "SDK API notes", read in this repository's `node_modules`.
- **New Relic MCP** (taken from the work package brief, which cites
  https://docs.newrelic.com/docs/agentic-ai/mcp/setup.md and https://docs.newrelic.com/docs/agentic-ai/mcp/tool-reference.md;
  this package did not fetch those pages again): the endpoints `https://mcp.newrelic.com/mcp/`,
  `https://mcp.eu.newrelic.com/mcp/` and `https://mcp.jp.newrelic.com/mcp/`; the `api-key` header; the `include-tags`
  header with values such as `data-access` and `incident-response`; an administrator enabling the MCP server and its
  API Keys sub-toggle in feature control; metering in Core Compute Units; the read tools named above; and the list of
  OAuth-only tools.
- **Sentry hosted MCP** at `https://mcp.sentry.dev/mcp` needs OAuth (from the same brief), which 0.4 does not support.
- **Behavior of this connector** is fixed by the tests in `tests/unit/connectors-mcp.unit.test.ts`, against an
  in-process server described in `tests/fixtures/connectors/mcp/README.md`.

## Unverified

- That New Relic accepts the `api-key` header from a generic MCP client. Its setup documentation, as relayed in the
  brief, lists only Cursor and the Antigravity CLI as clients. If the key is refused, the first call reports
  `authentication failed`.
- The input parameters of every New Relic tool. The allowlist names come from the tool reference; read the real
  schemas with `tools/list` (any MCP client or inspector can print them) before relying on an example argument.
- Whether each New Relic tool carries `readOnlyHint`, `destructiveHint` or neither. The connector does not need it:
  your allowlist decides.
- No test starts a real MCP server over stdio or HTTP; both transports were exercised only through stubs and the
  in-memory pair, so a server-specific handshake quirk can still appear in the first real run.
- Streamable HTTP servers that answer only with server-sent events on the first POST are handled by the SDK, but are
  not part of the tests.
