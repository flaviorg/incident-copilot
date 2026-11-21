// Generic outbound webhook notifier (spec 008, AC-56; docs/connectors/outbound-webhook.md): POSTs the notification as
// JSON to a URL of the team's choosing, optionally with a Bearer token and an HMAC-SHA256 signature the receiver can
// verify. The URL, the token and the signing secret never appear in an outcome.
import * as z from "zod";
import { ConnectorError } from "../../connectors/shared/errors.ts";
import { parseRetryAfter } from "../../connectors/shared/http.ts";
import { APP_VERSION } from "../../infra/app-info.ts";
import { hmacDigest } from "../../infra/crypto.ts";
import type { NotifyOutcome } from "../types.ts";
import { defineNotifier } from "../types.ts";
import { renderOutbound } from "./render.ts";

export const SEND_TIMEOUT_MS = 5000;
export const TIMESTAMP_HEADER = "x-incident-copilot-timestamp";
export const SIGNATURE_HEADER = "x-incident-copilot-signature";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const URL_RULE = "must be an https URL (http only for loopback hosts), without credentials";

/** Same rule as `h.url()`, for a URL that arrives through `h.secret()`. */
function isAllowedUrl(s: string): boolean {
  try {
    const u = new URL(s);
    if (u.username !== "" || u.password !== "") return false;
    return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
  } catch {
    return false;
  }
}

const failed = (retryable: boolean, reason: string, retryAfterSec: number | null = null): NotifyOutcome => ({ ok: false, retryable, retryAfterSec, reason });

export const outboundWebhookNotifier = defineNotifier({
  type: "outbound-webhook",
  configSchema: (h) =>
    z
      .strictObject({
        url: h.url().optional(),
        urlIsSecret: z.boolean().default(false),
        secretUrl: h.secret().optional(),
        signingSecret: h.secret({ min: 16 }).optional(),
        bearerToken: h.secret({ min: 16 }).optional(),
      })
      .superRefine((c, ctx) => {
        if (c.urlIsSecret) {
          if (c.url !== undefined) ctx.addIssue({ code: "custom", path: ["url"], message: "use secretUrl when urlIsSecret is true" });
          if (c.secretUrl === undefined) ctx.addIssue({ code: "custom", path: ["secretUrl"], message: "required when urlIsSecret is true" });
          else if (!isAllowedUrl(c.secretUrl)) ctx.addIssue({ code: "custom", path: ["secretUrl"], message: URL_RULE });
        } else {
          if (c.secretUrl !== undefined) ctx.addIssue({ code: "custom", path: ["secretUrl"], message: "only valid when urlIsSecret is true" });
          if (c.url === undefined) ctx.addIssue({ code: "custom", path: ["url"], message: "required" });
        }
      }),
  create: (config, deps) => {
    const target = config.urlIsSecret ? config.secretUrl! : config.url!;
    return {
      id: deps.id,
      type: "outbound-webhook",
      async send(m, io) {
        const body = renderOutbound(m);
        const headers: Record<string, string> = { "content-type": "application/json", "user-agent": `incident-copilot/${APP_VERSION}` };
        if (config.bearerToken !== undefined) headers["authorization"] = `Bearer ${config.bearerToken}`;
        if (config.signingSecret !== undefined) {
          const timestamp = String(Math.floor(Date.now() / 1000));
          headers[TIMESTAMP_HEADER] = timestamp;
          headers[SIGNATURE_HEADER] = "sha256=" + hmacDigest("sha256", config.signingSecret, Buffer.from(`${timestamp}.${body}`, "utf8"), "hex");
        }
        let res;
        try {
          res = await deps.http.request({ method: "POST", url: target, headers, body, timeoutMs: SEND_TIMEOUT_MS, signal: io.signal });
        } catch (e) {
          if (e instanceof ConnectorError) return failed(e.kind === "timeout" || e.kind === "unavailable", e.message);
          return failed(true, "unavailable");
        }
        if (res.status >= 200 && res.status < 300) return { ok: true };
        if (res.status === 429 || res.status >= 500) return failed(true, `http ${res.status}`, parseRetryAfter(res.headers.get("retry-after")));
        return failed(false, `http ${res.status}`);
      },
    };
  },
});
