// Inbound webhook authentication (spec 008, decision 10; AC-43). Each scheme is implemented once here: Bearer, Basic,
// a custom header, a secret URL token and HMAC over the raw body, with an optional exact-IP allowlist checked first.
// Every comparison is constant-time; nothing here logs or returns a credential.
import * as z from "zod";
import { constantTimeEqualsText, hmacDigest } from "../../infra/crypto.ts";
import type { ConfigHelpers } from "./config-helpers.ts";
import type { InboundRequest, VerifyOutcome } from "../types.ts";

type WithIps = { allowedIps?: string[] };
export type WebhookAuthConfig =
  | ({ type: "bearer"; token: string } & WithIps)
  | ({ type: "basic"; username: string; password: string } & WithIps)
  | ({ type: "header"; name: string; value: string } & WithIps)
  | ({ type: "path_token"; token: string } & WithIps)
  | ({ type: "hmac"; header: string; secret: string; algorithm: "sha256" | "sha1"; encoding: "hex" | "base64"; prefix: string } & WithIps);
export type WebhookAuthKind = WebhookAuthConfig["type"];

const HEADER_NAME = /^[a-z0-9-]{1,64}$/;
const RESERVED_HEADERS = new Set(["host", "content-length"]);
const PATH_TOKEN = /^[A-Za-z0-9_-]{24,128}$/;

const headerName = z
  .string()
  .regex(HEADER_NAME)
  .refine((n) => !RESERVED_HEADERS.has(n), { message: "header name not allowed" });

export function webhookAuthSchema(h: ConfigHelpers, kinds: readonly WebhookAuthKind[]): z.ZodType<WebhookAuthConfig> {
  const allowedIps = z.array(z.union([z.ipv4(), z.ipv6()])).min(1).max(50).optional();
  const variants: Record<WebhookAuthKind, z.ZodType> = {
    bearer: z.strictObject({ type: z.literal("bearer"), token: h.secret(), allowedIps }),
    basic: z.strictObject({ type: z.literal("basic"), username: h.text({ max: 200 }), password: h.secret(), allowedIps }),
    header: z.strictObject({ type: z.literal("header"), name: headerName, value: h.secret(), allowedIps }),
    path_token: z.strictObject({
      type: z.literal("path_token"),
      token: h.secret({ min: 24 }).pipe(z.string().regex(PATH_TOKEN)),
      allowedIps,
    }),
    hmac: z.strictObject({
      type: z.literal("hmac"),
      header: headerName,
      secret: h.secret(),
      algorithm: z.enum(["sha256", "sha1"]).default("sha256"),
      encoding: z.enum(["hex", "base64"]).default("hex"),
      prefix: z.string().max(32).default(""),
      allowedIps,
    }),
  };
  const options = kinds.map((k) => variants[k]) as unknown as [z.ZodObject, ...z.ZodObject[]];
  return z.discriminatedUnion("type", options) as unknown as z.ZodType<WebhookAuthConfig>;
}

/** ::ffff:10.0.0.1 is the IPv4 address 10.0.0.1 seen through an IPv6 socket. */
export function normalizeIp(ip: string): string {
  const v = ip.trim().toLowerCase();
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  return m ? m[1]! : v;
}

function bearerOf(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const m = /^bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
}

function basicOf(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const m = /^basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  if (!m) return null;
  return Buffer.from(m[1]!, "base64").toString("utf8");
}

const result = (ok: boolean, reason: Exclude<VerifyOutcome, { ok: true }>["reason"]): VerifyOutcome => (ok ? { ok: true } : { ok: false, reason });

/** Sync, never throws. The IP allowlist (when set) is checked before any credential. */
export function verifyWebhookAuth(auth: WebhookAuthConfig, req: InboundRequest): VerifyOutcome {
  try {
    if (auth.allowedIps && auth.allowedIps.length > 0) {
      const ip = normalizeIp(req.remoteAddress);
      let allowed = false;
      for (const a of auth.allowedIps) if (constantTimeEqualsText(ip, normalizeIp(a))) allowed = true;
      if (!allowed) return { ok: false, reason: "ip_not_allowed" };
    }
    switch (auth.type) {
      case "bearer": {
        const given = bearerOf(req.headers.authorization);
        if (given === null) return { ok: false, reason: "missing_credentials" };
        return result(constantTimeEqualsText(given, auth.token), "invalid_credentials");
      }
      case "basic": {
        const given = basicOf(req.headers.authorization);
        if (given === null) return { ok: false, reason: "missing_credentials" };
        return result(constantTimeEqualsText(given, `${auth.username}:${auth.password}`), "invalid_credentials");
      }
      case "header": {
        const given = req.headers[auth.name];
        if (typeof given !== "string" || given === "") return { ok: false, reason: "missing_credentials" };
        return result(constantTimeEqualsText(given, auth.value), "invalid_credentials");
      }
      case "path_token": {
        if (req.pathToken === null || req.pathToken === "") return { ok: false, reason: "missing_credentials" };
        return result(constantTimeEqualsText(req.pathToken, auth.token), "invalid_credentials");
      }
      case "hmac": {
        const raw = req.headers[auth.header];
        if (typeof raw !== "string" || raw === "") return { ok: false, reason: "missing_credentials" };
        let given = raw.trim();
        if (auth.prefix !== "") {
          if (!given.startsWith(auth.prefix)) return { ok: false, reason: "invalid_signature" };
          given = given.slice(auth.prefix.length);
        }
        if (auth.encoding === "hex") given = given.toLowerCase();
        const expected = hmacDigest(auth.algorithm, auth.secret, req.rawBody, auth.encoding);
        return result(constantTimeEqualsText(given, expected), "invalid_signature");
      }
    }
  } catch {
    return { ok: false, reason: "invalid_credentials" };
  }
}
