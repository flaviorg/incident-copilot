// API entry point (spec 5.3 and 8.4): reads the config, builds the container and listens on HOST:PORT (default 127.0.0.1:3000).
// An invalid config exits with code 1 and one JSON line on stderr, without echoing values. With COPILOT_CONFIG, the
// connectors of copilot.yaml receive alerts on /ingest/* (spec 008); the fake provider refuses ingest connectors.
import { assertApiExposureSafe, ConfigError, loadConfig } from "./config.ts";
import type { Config } from "./config.ts";
import { createContainer } from "./app/container.ts";
import { buildServer } from "./http/server.ts";
import { CopilotConfigError } from "./domain/errors.ts";
import { assertLiveSafe, loadCopilotConfigFile } from "./infra/copilot-config/load.ts";
import type { CopilotConfig } from "./infra/copilot-config/load.ts";
import { CONNECTOR_DEFINITIONS } from "./connectors/index.ts";
import { NOTIFIER_DEFINITIONS } from "./notifiers/index.ts";

let config: Config;
let copilot: CopilotConfig | null = null;
try {
  config = loadConfig(process.env);
  assertApiExposureSafe(config);
  if (config.copilotConfigPath !== null) {
    const r = loadCopilotConfigFile(config.copilotConfigPath, { env: process.env, connectors: CONNECTOR_DEFINITIONS, notifiers: NOTIFIER_DEFINITIONS });
    if (!r.ok) throw new CopilotConfigError(r.problems);
    copilot = r.config;
  }
  assertLiveSafe(config, copilot);
} catch (e) {
  const ts = new Date().toISOString();
  if (e instanceof ConfigError) {
    process.stderr.write(JSON.stringify({ ts, level: "error", msg: e.message, variables: e.variables }) + "\n");
    process.exit(1);
  }
  if (e instanceof CopilotConfigError) {
    process.stderr.write(JSON.stringify({ ts, level: "error", msg: "invalid copilot config", problems: e.problems }) + "\n");
    process.exit(1);
  }
  throw e;
}

const c = createContainer(config, { copilot });
const app = buildServer(c);
await app.listen({ host: config.host, port: config.port });
c.logger.info("api listening", { host: config.host, port: config.port, provider: config.llmProvider, connectors: c.connectors.list().map((x) => x.id) });
// Alerts recorded before a crash or restart but never handled.
c.ingest.recoverQueued();

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  c.logger.info("api shutting down", { signal });
  await app.close();
  await c.alertQueue.drain(config.runTimeoutMs);
  c.close();
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
