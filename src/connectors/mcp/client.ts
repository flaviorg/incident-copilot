// MCP client wrapper (docs/connectors/mcp.md, "SDK API notes"): one lazy connection per connector instance, shared by
// every call, with every SDK failure turned into a ConnectorError. Nothing here logs or returns headers, env, URLs or
// server text: the error kinds are the only thing that leaves.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { APP_VERSION } from "../../infra/app-info.ts";
import type { Logger } from "../../infra/logger.ts";
import { ConnectorError } from "../shared/errors.ts";
import type { McpConfig } from "./config.ts";

/** Cap on pages of tools/list, so a server that never stops paginating cannot hold the call. */
export const MAX_LIST_PAGES = 20;

export type McpClientOptions = {
  config: McpConfig;
  fetch: typeof fetch;
  logger: Logger;
  /** Tests inject an in-memory transport; production builds the HTTP or stdio one from the config. */
  transportFactory?: () => Transport;
  /** Called when the connection closes or fails, so cached state (the tool list) can be dropped. */
  onReset?: () => void;
};

export type McpCallIO = { signal: AbortSignal };

export interface McpConnection {
  /** Every page of tools/list. */
  listTools(io: McpCallIO): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>, io: McpCallIO): Promise<CallToolResult>;
  close(): Promise<void>;
}

function buildTransport(config: McpConfig, fetchFn: typeof fetch): Transport {
  if (config.transport === "stdio") {
    // stderr is dropped: a child could print its environment, and the copilot's own stderr carries redacted JSON logs only.
    return new StdioClientTransport({ command: config.command!, args: config.args ?? [], env: { ...(config.env ?? {}) }, stderr: "ignore" });
  }
  const headers: Record<string, string> = {};
  for (const h of config.headers ?? []) headers[h.name] = h.value;
  for (const [name, value] of Object.entries(config.secretHeaders ?? {})) headers[name] = value;
  return new StreamableHTTPClientTransport(new URL(config.url!), { requestInit: { headers }, fetch: fetchFn });
}

const isAbort = (e: unknown): boolean => e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");

/** The only place SDK errors are classified; the result carries no message from the SDK or the server. */
export function toConnectorError(e: unknown, signal?: AbortSignal): ConnectorError {
  if (e instanceof ConnectorError) return e;
  if (signal?.aborted || isAbort(e)) return new ConnectorError("timeout");
  if (e instanceof McpError) {
    if (e.code === ErrorCode.RequestTimeout) return new ConnectorError("timeout");
    if (e.code === ErrorCode.ConnectionClosed) return new ConnectorError("unavailable");
    return new ConnectorError("bad_response");
  }
  if (e instanceof UnauthorizedError) return new ConnectorError("auth");
  if (e instanceof StreamableHTTPError) {
    if (e.code === 401 || e.code === 403) return new ConnectorError("auth");
    if (e.code === 429) return new ConnectorError("rate_limited");
    if (e.code === -1) return new ConnectorError("bad_response");
    return new ConnectorError("unavailable");
  }
  // A response the SDK could not parse (JSON.parse or schema validation) is malformed; anything else is a transport failure.
  if (e instanceof SyntaxError || (e instanceof Error && e.name === "ZodError")) return new ConnectorError("bad_response");
  return new ConnectorError("unavailable");
}

export function createMcpConnection(o: McpClientOptions): McpConnection {
  let client: Client | null = null;
  let connecting: Promise<Client> | null = null;

  const reset = (c: Client) => {
    if (client !== c) return;
    client = null;
    connecting = null;
    o.onReset?.();
  };

  async function connect(io: McpCallIO): Promise<Client> {
    if (client) return client;
    if (!connecting) {
      const c = new Client({ name: "incident-copilot", version: APP_VERSION }, { capabilities: {} });
      const attempt = (async () => {
        const transport = (o.transportFactory ?? (() => buildTransport(o.config, o.fetch)))();
        c.onclose = () => reset(c);
        c.onerror = () => {}; // transport-level noise; failures surface through the request that was in flight
        try {
          await c.connect(transport, { signal: io.signal, timeout: o.config.timeoutMs });
        } catch (e) {
          await c.close().catch(() => {});
          throw e;
        }
        client = c;
        return c;
      })();
      connecting = attempt;
      attempt.catch(() => {
        if (connecting === attempt) connecting = null;
      });
    }
    return connecting;
  }

  return {
    async listTools(io) {
      try {
        const c = await connect(io);
        const tools: Tool[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
          const r = await c.listTools(cursor === undefined ? undefined : { cursor }, { signal: io.signal, timeout: o.config.timeoutMs });
          tools.push(...r.tools);
          if (!r.nextCursor || r.nextCursor === cursor) return tools;
          cursor = r.nextCursor;
        }
        o.logger.warn("mcp tools/list stopped after the page limit", { event: "mcp_list_truncated", pages: MAX_LIST_PAGES });
        return tools;
      } catch (e) {
        throw toConnectorError(e, io.signal);
      }
    },
    async callTool(name, args, io) {
      try {
        const c = await connect(io);
        return (await c.callTool({ name, arguments: args }, undefined, { signal: io.signal, timeout: o.config.timeoutMs })) as CallToolResult;
      } catch (e) {
        throw toConnectorError(e, io.signal);
      }
    },
    async close() {
      const c = client ?? (await connecting?.catch(() => null)) ?? null;
      client = null;
      connecting = null;
      if (c) await c.close().catch(() => {});
    },
  };
}
