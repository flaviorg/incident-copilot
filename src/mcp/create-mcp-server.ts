// Servidor MCP "incident-copilot" (spec 5.4) sobre o mesmo container da API (mesmo DB_PATH). Três tools: duas de
// leitura e uma de proposta que nunca aprova nem executa.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Container } from "../app/container.ts";
import { APP_VERSION } from "../infra/app-info.ts";
import { registerListIncidents } from "./tools/list-incidents.ts";
import { registerGetIncident } from "./tools/get-incident.ts";
import { registerProposeRemediation } from "./tools/propose-remediation.ts";

const MCP_SERVER_NAME = "incident-copilot";

export function createMcpServer(c: Container): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: APP_VERSION });
  registerListIncidents(server, c);
  registerGetIncident(server, c);
  registerProposeRemediation(server, c);
  return server;
}
