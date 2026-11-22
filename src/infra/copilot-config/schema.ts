// copilot.yaml schema (spec 008, decisions 6 and 12). Built at load time from the registered connector and notifier
// definitions: a strict base entry, then each definition's own schema for the rest of the entry.
import * as z from "zod";
import { ConnectorIdSchema, SeveritySchema } from "../../contracts/index.ts";
import type { Severity } from "../../contracts/index.ts";
import type { ServiceMap } from "../../domain/ingest/service-map.ts";
import type { ConfigHelpers } from "../../connectors/shared/config-helpers.ts";
import { DEFAULT_NOTIFICATION_EVENTS, NOTIFICATION_KINDS } from "../../notifiers/types.ts";
import type { NotificationKind } from "../../notifiers/types.ts";
import { CODE_FIX_CEILINGS, CODE_FIX_DEFAULT_LIMITS, CODE_FIX_FLOORS } from "../../domain/code-fix/limits.ts";
import type { CodeFixLimits } from "../../domain/code-fix/limits.ts";

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
  /** The code fixer (spec 009); null when the section is absent. */
  codeFix: CodeFixConfig | null;
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
    codeFix: CodeFixConfigSchema(h).optional(),
  });
}

// ---- codeFix (spec 009, decisions 7, 10, 16, 19 and 20; AC-84) ----

export const REPO_RULE = "must be owner/name (letters, digits, '_', '.' or '-', at most 100 each)";
export const REF_NAME_RULE = "must be a valid branch name";
export const GLOB_RULE = "globs may use only letters, digits and _ . / * { } , -, with no leading '-' or '/' and no '..'";
export const EXCEPTION_TYPE_RULE = "must be an exception class name";
export const AUTHOR_RULE = "must be a plain name and an email address";
export const API_URL_RULE = "must not have a query or a fragment";

const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/;
export function isValidRepo(s: string): boolean {
  const parts = s.split("/");
  return parts.length === 2 && parts.every((p) => REPO_PART.test(p) && p !== "." && p !== "..");
}

/** A conservative subset of git-check-ref-format for branch names. */
export function isValidRefName(s: string): boolean {
  if (s.length < 1 || s.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(s)) return false;
  if (s.startsWith("-") || s.endsWith("/") || s.endsWith(".") || s.endsWith(".lock") || s.includes("..") || s.includes("//")) return false;
  return s.split("/").every((c) => c !== "" && !c.startsWith(".") && !c.endsWith(".lock"));
}

/** Decision 7: test and path globs reach the runner's argv, so they pass a strict allowlist. */
export function isAllowedGlob(s: string): boolean {
  return s.length <= 200 && /^[A-Za-z0-9_./*{},-]+$/.test(s) && !s.startsWith("-") && !s.startsWith("/") && !s.includes("..");
}

const CODE_FIX_LIMIT_KEYS = Object.keys(CODE_FIX_CEILINGS) as (keyof CodeFixLimits)[];
const limitField = (k: keyof CodeFixLimits) => z.number().int().min(CODE_FIX_FLOORS[k]).max(CODE_FIX_CEILINGS[k]).default(CODE_FIX_DEFAULT_LIMITS[k]);
const limitsShape = Object.fromEntries(CODE_FIX_LIMIT_KEYS.map((k) => [k, limitField(k)])) as Record<keyof CodeFixLimits, ReturnType<typeof limitField>>;

export const DEFAULT_GITHUB_API_URL = "https://api.github.com";
export const DEFAULT_COMMIT_AUTHOR = { name: "incident-copilot", email: "incident-copilot@example.invalid" } as const;
export const DEFAULT_FIXABLE_EXCEPTION_TYPES = ["TypeError", "RangeError", "ReferenceError"] as const;

export type CodeFixRepository = {
  repo: string;
  service: string;
  connector: string;
  baseBranch: string;
  pathPrefixes: string[];
  sourceGlobs: string[];
  testGlobs: string[];
  testFiles: string[];
  deniedPaths: string[];
};

export type CodeFixConfig = {
  enabled: boolean;
  mode: "shadow" | "draft_pr";
  approvalTtlHours: number;
  sandbox: { network: "isolated" | "best_effort" };
  github: { apiUrl: string; token: string | null };
  commitAuthor: { name: string; email: string };
  limits: CodeFixLimits;
  fixableExceptionTypes: string[];
  repositories: CodeFixRepository[];
};

/** The `codeFix` section. Strict throughout; config can only lower the limits in src/domain/code-fix/limits.ts. */
export function CodeFixConfigSchema(h: ConfigHelpers): z.ZodType<CodeFixConfig> {
  const glob = h.text({ max: 200 }).refine(isAllowedGlob, { message: GLOB_RULE });
  const globs = (min: number, max: number) => z.array(glob).min(min).max(max);
  const repository = z.strictObject({
    repo: h.text({ max: 201 }).refine(isValidRepo, { message: REPO_RULE }),
    service: h.text({ max: 120 }),
    connector: h.text({ max: 64 }),
    baseBranch: h.text({ max: 300 }).refine(isValidRefName, { message: REF_NAME_RULE }),
    pathPrefixes: z.array(h.text({ max: 200 })).max(10).default([]),
    sourceGlobs: globs(1, 20),
    testGlobs: globs(1, 20),
    testFiles: globs(1, 20),
    deniedPaths: globs(0, 50).default([]),
  });
  return z.strictObject({
    enabled: z.boolean().default(true),
    mode: z.enum(["shadow", "draft_pr"]).default("shadow"),
    approvalTtlHours: z.number().int().min(1).max(168).default(72),
    sandbox: z.strictObject({ network: z.enum(["isolated", "best_effort"]).default("isolated") }).default({ network: "isolated" }),
    // The GitHub client refuses a query or a fragment at startup; refusing it here keeps `config check` honest.
    github: z
      .strictObject({ apiUrl: h.url().refine((s) => !/[?#]/.test(s), { message: API_URL_RULE }).default(DEFAULT_GITHUB_API_URL), token: h.secret().nullable().default(null) })
      .default({ apiUrl: DEFAULT_GITHUB_API_URL, token: null }),
    commitAuthor: z
      .strictObject({
        name: h.text({ max: 100 }).refine((s) => !/[<>\n\r]/.test(s) && s.trim() !== "", { message: AUTHOR_RULE }),
        email: h.text({ max: 200 }).refine((s) => /^[^\s@<>]+@[^\s@<>]+$/.test(s), { message: AUTHOR_RULE }),
      })
      .default({ ...DEFAULT_COMMIT_AUTHOR }),
    limits: z.strictObject(limitsShape).default({ ...CODE_FIX_DEFAULT_LIMITS }),
    fixableExceptionTypes: z
      .array(h.text({ max: 64 }).refine((s) => /^[A-Z][A-Za-z0-9_]{0,63}$/.test(s), { message: EXCEPTION_TYPE_RULE }))
      .min(1)
      .max(20)
      .default([...DEFAULT_FIXABLE_EXCEPTION_TYPES]),
    repositories: z.array(repository).min(1).max(20),
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
  events: z.array(z.enum(NOTIFICATION_KINDS as [NotificationKind, ...NotificationKind[]])).min(1).max(6).default([...DEFAULT_NOTIFICATION_EVENTS]),
});

export const CONNECTOR_BASE_KEYS = ["id", "type", "enabled", "severityMap"] as const;
export const NOTIFIER_BASE_KEYS = ["id", "type", "events"] as const;
