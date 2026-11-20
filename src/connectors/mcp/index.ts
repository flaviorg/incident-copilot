// Generic MCP data source connector (spec 008, AC-50 and AC-58; docs/connectors/mcp.md): exposes an operator-chosen
// allowlist of read-only tools of any MCP server (New Relic, a local stdio server, ...) as the `external` query
// capability. It has no ingest side. `create` performs no I/O: the connection opens on the first tools() or call().
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { defineConnector } from "../types.ts";
import type { ConnectorDeps, ConnectorInstance } from "../types.ts";
import { createMcpConnection } from "./client.ts";
import { mcpConfigSchema } from "./config.ts";
import type { McpConfig } from "./config.ts";
import { createMcpQuery } from "./query.ts";

export type { McpConfig } from "./config.ts";

/** Builds an instance from a parsed config; `transportFactory` lets tests supply an in-memory transport. */
export function createMcpConnector(config: McpConfig, deps: ConnectorDeps, o: { transportFactory?: () => Transport } = {}): ConnectorInstance {
  let resetTools = () => {};
  const connection = createMcpConnection({
    config,
    fetch: deps.fetch,
    logger: deps.logger,
    ...(o.transportFactory ? { transportFactory: o.transportFactory } : {}),
    onReset: () => resetTools(),
  });
  const q = createMcpQuery({ config, connection, logger: deps.logger });
  resetTools = q.resetTools;
  return {
    id: deps.id,
    type: "mcp",
    ingest: null,
    query: q.query,
    close: () => connection.close(),
  };
}

export const mcpConnector = defineConnector({
  type: "mcp",
  displayName: "MCP data source",
  capabilities: ["query"],
  configSchema: mcpConfigSchema,
  create: (config, deps) => createMcpConnector(config, deps),
});
