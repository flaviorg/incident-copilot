// MCP stdio entrypoint (spec 5.4; AC-34). stdout is reserved for JSON-RPC: before any application import,
// console.log, console.info and console.debug start writing to stderr. That is why the rest comes via dynamic import
// (static imports would be evaluated before this redirect). JSON logs go to stderr via the logger.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.debug = (...args: unknown[]) => console.error(...args);

export {}; // ES module with no static import (top-level await requires a module)

const { ConfigError, loadConfig } = await import("../config.ts");
const { createContainer } = await import("../app/container.ts");
const { createMcpServer } = await import("./create-mcp-server.ts");
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

let config;
try {
  config = loadConfig(process.env);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: e.message, variables: e.variables }) + "\n");
  process.exit(1);
}

const c = createContainer(config);
const server = createMcpServer(c);
const transport = new StdioServerTransport();

let closed = false;
const shutdown = async (why: string) => {
  if (closed) return;
  closed = true;
  c.logger.info("mcp shutting down", { reason: why });
  await server.close().catch(() => {});
  c.close();
};
transport.onclose = () => void shutdown("transport closed");
process.stdin.once("end", () => void shutdown("stdin ended"));
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await server.connect(transport);
c.logger.info("mcp ready", { server: "incident-copilot", transport: "stdio", provider: config.llmProvider });
