// Live connector instances built from copilot.yaml (spec 008, decision 1). Only enabled entries are created; `create`
// performs no I/O, so building the registry never touches the network.
import type { Logger } from "../infra/logger.ts";
import type { ConnectorEntry } from "../infra/copilot-config/schema.ts";
import type { LiveSource } from "../tools/context.ts";
import { createHttpClient } from "./shared/http.ts";
import type { ConnectorDefinition, ConnectorDeps, ConnectorInstance } from "./types.ts";

export type ConnectorSummary = { id: string; type: string; capabilities: ("ingest" | "query")[]; ingestPath: string | null };

export interface ConnectorRegistry {
  get(id: string): ConnectorInstance | null;
  list(): ConnectorSummary[];
  /** Instances with a query capability, in config order (the tool registry calls them in this order). */
  querySources(): LiveSource[];
  close(): Promise<void>;
}

/** Builds one instance the way the registry does: the parsed config plus the base entry's severityMap. */
export function createConnectorInstance(
  definition: ConnectorDefinition<unknown>,
  entry: Pick<ConnectorEntry, "id" | "severityMap" | "config">,
  deps: Omit<ConnectorDeps, "id">,
): ConnectorInstance {
  const config = { ...(entry.config as object), severityMap: entry.severityMap };
  return definition.create(config, { ...deps, id: entry.id });
}

export function createConnectorRegistry(o: {
  definitions: readonly ConnectorDefinition<unknown>[];
  entries: readonly ConnectorEntry[];
  fetch: typeof fetch;
  now: () => Date;
  logger: Logger;
}): ConnectorRegistry {
  const instances: ConnectorInstance[] = [];
  for (const e of o.entries) {
    if (!e.enabled) continue;
    const def = o.definitions.find((d) => d.type === e.type);
    if (!def) throw new Error(`connector ${e.id}: type ${e.type} is not registered`);
    instances.push(createConnectorInstance(def, e, {
      http: createHttpClient({ fetch: o.fetch }),
      fetch: o.fetch,
      now: o.now,
      logger: o.logger.child({ connectorId: e.id }),
    }));
  }
  const byId = new Map(instances.map((i) => [i.id, i]));
  return {
    get: (id) => byId.get(id) ?? null,
    list: () =>
      instances.map((i) => ({
        id: i.id,
        type: i.type,
        capabilities: [...(i.ingest ? ["ingest" as const] : []), ...(i.query ? ["query" as const] : [])],
        ingestPath: i.ingest ? `/ingest/${i.id}` : null,
      })),
    querySources: () => instances.filter((i) => i.query !== null).map((i) => ({ connectorId: i.id, type: i.type, query: i.query! })),
    async close() {
      for (const i of instances) {
        try {
          await i.close?.();
        } catch {
          o.logger.warn("connector close failed", { event: "connector_close_failed", connectorId: i.id });
        }
      }
    },
  };
}
