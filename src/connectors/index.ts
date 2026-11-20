// The only list of registered connector types. Packages export their definition; the integration task appends here.
import type { ConnectorDefinition } from "./types.ts";
import { alertmanagerConnector } from "./alertmanager/index.ts";
import { newRelicConnector } from "./newrelic/index.ts";
import { sentryConnector } from "./sentry/index.ts";
import { bugsnagConnector } from "./bugsnag/index.ts";
import { webhookConnector } from "./webhook/index.ts";
import { mcpConnector } from "./mcp/index.ts";

export const CONNECTOR_DEFINITIONS: readonly ConnectorDefinition<unknown>[] = [
  alertmanagerConnector,
  newRelicConnector,
  sentryConnector,
  bugsnagConnector,
  webhookConnector,
  mcpConnector,
];
