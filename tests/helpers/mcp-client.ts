// Real MCP client against the stdio server in a child process (spec 5.4 and 8.1), with the network blocked in the child too
// and without inheriting the environment (only PATH, HOME and whatever the test passes). The child's stderr is available line by line.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CHILD_NODE_ARGS, PROJECT_ROOT } from "./spawn.ts";

export const TEST_MCP_CLIENT_NAME = "incident-copilot-tests";

export async function createTestClient(o: { dbPath: string; env?: Record<string, string> }): Promise<{ client: Client; stderr: string[]; close(): Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...CHILD_NODE_ARGS, "src/mcp/server.ts"],
    cwd: PROJECT_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      DB_PATH: o.dbPath,
      LLM_PROVIDER: "fake",
      CLOCK: "simulated",
      LOG_LEVEL: "debug",
      ...o.env,
    },
    stderr: "pipe",
  });
  const stderr: string[] = [];
  let partial = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    const parts = (partial + String(chunk)).split("\n");
    partial = parts.pop() ?? "";
    for (const line of parts) if (line.trim() !== "") stderr.push(line);
  });
  const client = new Client({ name: TEST_MCP_CLIENT_NAME, version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    stderr,
    async close() {
      await client.close();
      if (partial.trim() !== "") stderr.push(partial);
      partial = "";
    },
  };
}
