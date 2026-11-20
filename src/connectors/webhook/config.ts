// Generic JSON webhook connector config (docs/connectors/webhook.md). The sender is any tool that can POST JSON; the
// entry says where in the body each NormalizedAlert field lives. Paths are checked at load time so a typo or a
// prototype segment fails `config check`, not an incident.
import * as z from "zod";
import { AlertSignalSchema, SeveritySchema } from "../../contracts/index.ts";
import type { ConfigHelpers } from "../shared/config-helpers.ts";
import { webhookAuthSchema } from "../shared/auth.ts";

export const MAX_PATH_SEGMENTS = 10;
export const MAX_TEMPLATE_PLACEHOLDERS = 10;
export const MAX_MAPPED_ATTRIBUTES = 20;
export const DEFAULT_MAX_ALERTS_PER_REQUEST = 20;
export const DEFAULT_RESOLVED_VALUES: readonly string[] = ["resolved", "ok", "closed"];

const PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const ATTRIBUTE_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const PLACEHOLDER = /\{([^{}]*)\}/g;

/** Dot path with numeric indexes, at most 10 segments, never __proto__, constructor or prototype. */
export function isValidPath(p: string): boolean {
  if (!PATH.test(p)) return false;
  const segments = p.split(".");
  return segments.length <= MAX_PATH_SEGMENTS && !segments.some((s) => FORBIDDEN_SEGMENTS.has(s));
}

export const PATH_RULE = "must be a dot path of at most 10 segments (letters, digits, _ and -), without __proto__, constructor or prototype";
const TEMPLATE_RULE = "template placeholders must be {path}, at most 10, each a valid path; other braces are not allowed";

/** Placeholder paths of a template in order, or null when the template is malformed. */
export function templatePlaceholders(template: string): string[] | null {
  const paths: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) paths.push(m[1]!);
  if (paths.length > MAX_TEMPLATE_PLACEHOLDERS || !paths.every(isValidPath)) return null;
  if (/[{}]/.test(template.replace(PLACEHOLDER, ""))) return null;
  return paths;
}

export const FINGERPRINT_RULE = "fingerprint is required when status is mapped: a resolved event only closes the incident when it shares the firing alert's fingerprint";
const pathSchema = z.string().refine(isValidPath, { message: PATH_RULE });
const templateSchema = z.strictObject({
  template: z.string().min(1).max(300).refine((t) => templatePlaceholders(t) !== null, { message: TEMPLATE_RULE }),
});

export function webhookConfigSchema(h: ConfigHelpers) {
  return z.strictObject({
    ingest: z.strictObject({
      auth: webhookAuthSchema(h, ["bearer", "basic", "header", "hmac", "path_token"]),
      mapping: z.strictObject({
        /** When set, the value at this path must be an array and each element is one alert. */
        alerts: pathSchema.optional(),
        externalId: pathSchema,
        /** Defaults to the externalId value. */
        fingerprint: pathSchema.optional(),
        service: pathSchema.optional(),
        title: z.union([pathSchema, templateSchema]),
        severity: z
          .strictObject({
            path: pathSchema,
            map: z.record(z.string().min(1).max(100), SeveritySchema).default({}),
            default: SeveritySchema.default("sev3"),
          })
          .optional(),
        status: z
          .strictObject({
            path: pathSchema,
            resolvedValues: z.array(z.string().min(1).max(100)).min(1).max(20).default([...DEFAULT_RESOLVED_VALUES]),
          })
          .optional(),
        startedAt: pathSchema.optional(),
        url: pathSchema.optional(),
        signal: AlertSignalSchema.default("other"),
        attributes: z
          .record(z.string().regex(ATTRIBUTE_NAME), pathSchema)
          .refine((a) => Object.keys(a).length <= MAX_MAPPED_ATTRIBUTES, { message: `at most ${MAX_MAPPED_ATTRIBUTES} attributes` })
          .optional(),
      }).superRefine((m, ctx) => {
        // A resolved event carries its own externalId; without a shared fingerprint it never matches the open incident.
        if (m.status !== undefined && m.fingerprint === undefined) {
          ctx.addIssue({ code: "custom", path: ["fingerprint"], message: FINGERPRINT_RULE });
        }
      }),
      maxAlertsPerRequest: z.number().int().min(1).max(100).default(DEFAULT_MAX_ALERTS_PER_REQUEST),
    }),
  });
}

export type WebhookConfig = z.infer<ReturnType<typeof webhookConfigSchema>>;
export type WebhookMapping = WebhookConfig["ingest"]["mapping"];
