// Slack notifier (spec 008, AC-56; docs/connectors/slack.md): one message per notification to an incoming webhook.
// The webhook URL is itself a secret: it comes from the environment, is redacted everywhere and is never part of an
// outcome. A send never throws and carries only a fixed reason.
import * as z from "zod";
import { ConnectorError } from "../../connectors/shared/errors.ts";
import { parseRetryAfter } from "../../connectors/shared/http.ts";
import type { NotifyOutcome } from "../types.ts";
import { defineNotifier } from "../types.ts";
import { renderSlack } from "./render.ts";

export const SLACK_WEBHOOK_PREFIX = "https://hooks.slack.com/services/";
export const SEND_TIMEOUT_MS = 5000;

/** The plain-text errors Slack documents for incoming webhooks; none of them is worth a retry. */
export const SLACK_PERMANENT_ERRORS: ReadonlySet<string> = new Set([
  "invalid_payload", "no_text", "no_service", "no_service_id", "no_active_hooks", "invalid_token", "action_prohibited",
  "channel_is_archived", "channel_not_found", "user_not_found", "no_team", "team_disabled", "posting_to_general_channel_denied",
  "too_many_attachments",
]);

const URL_RULE = "must be a https://hooks.slack.com/services/ URL, or an https URL whose host is listed in allowedHosts";
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

const failed = (retryable: boolean, reason: string, retryAfterSec: number | null = null): NotifyOutcome => ({ ok: false, retryable, retryAfterSec, reason });

export const slackNotifier = defineNotifier({
  type: "slack",
  configSchema: (h) =>
    z
      .strictObject({
        webhookUrl: h.secret({ min: 30 }),
        allowedHosts: z.array(z.string().max(253).regex(HOST)).max(10).default([]),
      })
      .superRefine((c, ctx) => {
        const hosts = c.allowedHosts.map((x) => x.toLowerCase());
        let ok = c.webhookUrl.startsWith(SLACK_WEBHOOK_PREFIX);
        if (!ok) {
          try {
            const u = new URL(c.webhookUrl);
            ok = u.protocol === "https:" && u.username === "" && u.password === "" && hosts.includes(u.hostname.toLowerCase());
          } catch {
            ok = false;
          }
        }
        if (!ok) ctx.addIssue({ code: "custom", path: ["webhookUrl"], message: URL_RULE });
      }),
  create: (config, deps) => ({
    id: deps.id,
    type: "slack",
    async send(m, io) {
      let res;
      try {
        res = await deps.http.request({
          method: "POST",
          url: config.webhookUrl,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(renderSlack(m)),
          timeoutMs: SEND_TIMEOUT_MS,
          signal: io.signal,
        });
      } catch (e) {
        if (e instanceof ConnectorError) return failed(e.kind === "timeout" || e.kind === "unavailable", e.message);
        return failed(true, "unavailable");
      }
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      if (res.status === 200) return res.text.trim() === "ok" ? { ok: true } : failed(false, "unexpected response");
      if (res.status === 429) return failed(true, "rate limited", retryAfter);
      if (res.status >= 500) return failed(true, `http ${res.status}`, retryAfter);
      const code = res.text.trim();
      return failed(false, SLACK_PERMANENT_ERRORS.has(code) ? code : "rejected");
    },
  }),
});
