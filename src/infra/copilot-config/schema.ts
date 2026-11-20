// copilot.yaml schema (spec 008, decisions 6 and 12). Built at load time from the registered connector and notifier
// definitions: a strict base entry, then each definition's own schema for the rest of the entry.
import * as z from "zod";
import { ConnectorIdSchema, SeveritySchema } from "../../contracts/index.ts";
import type { Severity } from "../../contracts/index.ts";
import type { ServiceMap } from "../../domain/ingest/service-map.ts";
import type { ConfigHelpers } from "../../connectors/shared/config-helpers.ts";
import { NOTIFICATION_KINDS } from "../../notifiers/types.ts";
import type { NotificationKind } from "../../notifiers/types.ts";

export const DEFAULT_INGEST = { maxBodyBytes: 1_048_576, rateLimitPerMin: 60, maxQueued: 100, dedupeWindowMin: 1440, trustProxy: false as TrustProxySetting } as const;

/** false: the socket address; a hop count: that many proxies in front; a list: only these proxy addresses or CIDR ranges. Never plain `true`. */
export type TrustProxySetting = false | number | string[];

export type IngestSettings = { maxBodyBytes: number; rateLimitPerMin: number; maxQueued: number; dedupeWindowMin: number; trustProxy: TrustProxySetting };

export const TRUST_PROXY_RULE =
  "must be false, a number of proxy hops (1 to 10) or a list of proxy addresses or CIDR ranges; true would let any client choose its address through X-Forwarded-For";
const PROXY_ADDRESS = /^(?:\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?|[0-9A-Fa-f:]{2,39}(?:\/\d{1,3})?)$/;
const trustProxySchema = z.unknown().default(false).transform((v, ctx): TrustProxySetting => {
  const ok =
    v === false ||
    (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 10) ||
    (Array.isArray(v) && v.length >= 1 && v.length <= 50 && v.every((x) => typeof x === "string" && PROXY_ADDRESS.test(x)));
  if (!ok) {
    ctx.addIssue({ code: "custom", message: TRUST_PROXY_RULE });
    return z.NEVER;
  }
  return v as TrustProxySetting;
});

export type ConnectorEntry = {
  id: string;
  type: string;
  enabled: boolean;
  severityMap: Record<string, Severity> | null;
  /** Capabilities the definition declares (the instance may expose fewer, e.g. a Sentry entry without ingest). */
  capabilities: readonly ("ingest" | "query")[];
  /** Output of the definition's configSchema. */
  config: unknown;
};

export type NotifierEntry = { id: string; type: string; events: NotificationKind[]; config: unknown };

export type CopilotConfig = {
  version: 1;
  /** The only operating mode for live incidents in 0.4. */
  mode: "shadow";
  /** Base URL of the copilot for links in notifications (no trailing slash), or null. */
  publicUrl: string | null;
  ingest: IngestSettings;
  services: ServiceMap;
  connectors: ConnectorEntry[];
  notifiers: NotifierEntry[];
  /** Every secret resolved from the file, for the redaction list (AC-52). */
  secrets: readonly string[];
};

export const MODE_RULE = "only shadow is supported in 0.4";

/** Top level of the file. Connector and notifier entries are checked one by one afterwards. */
export function topLevelSchema(h: ConfigHelpers) {
  const name = h.text({ max: 120 });
  return z.strictObject({
    version: z.literal(1),
    mode: z.string().default("shadow").refine((m) => m === "shadow", { message: MODE_RULE }),
    publicUrl: h.url().transform((u) => u.replace(/\/+$/, "")).nullable().default(null),
    ingest: z
      .strictObject({
        maxBodyBytes: z.number().int().min(1024).max(5_242_880).default(DEFAULT_INGEST.maxBodyBytes),
        rateLimitPerMin: z.number().int().min(1).max(6000).default(DEFAULT_INGEST.rateLimitPerMin),
        maxQueued: z.number().int().min(1).max(10_000).default(DEFAULT_INGEST.maxQueued),
        dedupeWindowMin: z.number().int().min(1).max(43_200).default(DEFAULT_INGEST.dedupeWindowMin),
        trustProxy: trustProxySchema,
      })
      .default({ ...DEFAULT_INGEST }),
    services: z
      .array(z.strictObject({ name, aliases: z.record(z.string().min(1).max(64), z.array(name).max(20)).default({}) }))
      .max(500)
      .default([]),
    connectors: z.array(z.unknown()).max(100).default([]),
    notifiers: z.array(z.unknown()).max(50).default([]),
  });
}

export const ConnectorBaseSchema = z.strictObject({
  id: ConnectorIdSchema,
  type: z.string().min(1).max(64),
  enabled: z.boolean().default(true),
  severityMap: z.record(z.string().min(1).max(64), SeveritySchema).nullable().default(null),
});

export const NotifierBaseSchema = z.strictObject({
  id: ConnectorIdSchema,
  type: z.string().min(1).max(64),
  events: z.array(z.enum(NOTIFICATION_KINDS as [NotificationKind, ...NotificationKind[]])).min(1).max(4).default([...NOTIFICATION_KINDS]),
});

export const CONNECTOR_BASE_KEYS = ["id", "type", "enabled", "severityMap"] as const;
export const NOTIFIER_BASE_KEYS = ["id", "type", "events"] as const;
