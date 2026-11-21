// Live-mode test setup: a parsed copilot config from YAML text, with explicit definitions and environment.
import assert from "node:assert/strict";
import { parseCopilotConfig } from "../../src/infra/copilot-config/load.ts";
import type { CopilotConfig } from "../../src/infra/copilot-config/schema.ts";
import type { ConnectorDefinition } from "../../src/connectors/types.ts";
import type { NotifierDefinition } from "../../src/notifiers/types.ts";

export function liveCopilot(
  yaml: string,
  o: { env: Record<string, string>; connectors: readonly ConnectorDefinition<unknown>[]; notifiers?: readonly NotifierDefinition<unknown>[] },
): CopilotConfig {
  const r = parseCopilotConfig(yaml, { format: "yaml", env: o.env, connectors: o.connectors, notifiers: o.notifiers ?? [] });
  assert.ok(r.ok, `copilot config: ${JSON.stringify(!r.ok && r.problems)}`);
  return r.config;
}
