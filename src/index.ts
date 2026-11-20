// API entry point (spec 5.3 and 8.4): reads the config, builds the container and listens on HOST:PORT (default 127.0.0.1:3000).
// An invalid config exits with code 1 and one JSON line on stderr, without echoing values.
import { assertApiExposureSafe, ConfigError, loadConfig } from "./config.ts";
import { createContainer } from "./app/container.ts";
import { buildServer } from "./http/server.ts";

let config;
try {
  config = loadConfig(process.env);
  assertApiExposureSafe(config);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: e.message, variables: e.variables }) + "\n");
  process.exit(1);
}

const c = createContainer(config);
const app = buildServer(c);
await app.listen({ host: config.host, port: config.port });
c.logger.info("api listening", { host: config.host, port: config.port, provider: config.llmProvider });

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  c.logger.info("api shutting down", { signal });
  await app.close();
  c.close();
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
