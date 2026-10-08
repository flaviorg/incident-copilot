// Entrypoint MCP por stdio (spec 5.4; AC-34). O stdout é exclusivo do JSON-RPC: antes de qualquer import da aplicação,
// console.log, console.info e console.debug passam a escrever em stderr. Por isso o resto vem por import dinâmico
// (imports estáticos seriam avaliados antes deste redirecionamento). Logs JSON vão para stderr pelo logger.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.debug = (...args: unknown[]) => console.error(...args);

export {}; // módulo ES sem import estático (o top-level await exige módulo)

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
