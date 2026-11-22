# Slack

Type `slack`, a notifier. It posts one message to a Slack channel through an
[incoming webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks) when a live incident is
opened, when its analysis is ready, when its run fails and when it is resolved. It only sends: nothing in Slack can
approve, reject or run anything, and a failed send is logged and never changes the incident.

Every message says plainly that live incidents run in shadow mode: the plan lists what the copilot would do, with the
tier from the catalog, and nothing was executed.

## 1. Create the webhook in Slack

The menu names below are how the Slack UI is usually described; check them against your workspace, because Slack
changes its screens and this guide did not re-read them for 0.4.0.

1. Open <https://api.slack.com/apps> and choose **Create New App**, then **From scratch**. Name it (for example
   "Incident Copilot") and pick the workspace.
2. In the app's settings, open **Incoming Webhooks** and turn **Activate Incoming Webhooks** on.
3. Choose **Add New Webhook to Workspace**, pick the channel and allow it.
4. Copy the **Webhook URL**. It looks like `https://hooks.slack.com/services/T.../B.../...`.

The webhook is bound to the channel you picked. The copilot cannot change the channel, the user name or the icon;
Slack ignores those fields for incoming webhooks. Create one webhook per channel and one `slack` notifier per webhook.

**The webhook URL is a secret.** Anyone who has it can post to the channel. Keep it in the environment, never in
`copilot.yaml`, and never paste it in a ticket or chat.

## 2. Configure the copilot

Put the URL in the environment of the copilot (it must be at least 30 characters):

```sh
export SLACK_WEBHOOK_URL='https://hooks.slack.com/services/T000/B000/xxxxxxxx'
```

`copilot.yaml` (path in `COPILOT_CONFIG`):

```yaml
version: 1
mode: shadow
publicUrl: https://copilot.example.com      # optional; makes "Open incident" a link
notifiers:
  - id: incidents-channel
    type: slack
    webhookUrl: "${SLACK_WEBHOOK_URL}"       # a whole ${VAR} reference; a literal URL is refused
    events: [incident_opened, analysis_ready, run_failed, incident_resolved]   # the default; add code_fix_ready, code_fix_pr_opened to opt in
    # allowedHosts: [hooks.slack-gov.example]   # only for a Slack deployment on another host, see below
```

| Key | Meaning |
|---|---|
| `webhookUrl` | Required. `${VAR}` naming a variable of at least 30 characters. The value must start with `https://hooks.slack.com/services/`, or be an `https` URL whose host is in `allowedHosts`. |
| `allowedHosts` | Optional list of host names (no scheme, no port, at most 10). For Slack deployments that do not use `hooks.slack.com`, such as GovSlack: **check the incoming-webhook host of your workspace** (this guide did not verify it). |
| `events` | Optional. Any of `incident_opened`, `analysis_ready`, `run_failed`, `incident_resolved`, plus the opt-in code-fixer kinds `code_fix_ready` and `code_fix_pr_opened` (see [the code fixer](../code-fixer.md)). Defaults to the first four; the code-fix kinds are sent only when listed. |

Unknown keys are refused (there is no `channel` key on purpose). Check the file with `npm run cli -- config check`;
a problem is reported by path and rule and never shows the URL.

## 3. What a message looks like

The `text` fallback (shown in notifications and by screen readers) is one line:

```
[SEV2] Analysis ready: High error rate in checkout (checkout-api)
```

The other kinds read `Incident opened`, `Run failed` and `Resolved`. The blocks, from top to bottom:

1. **Title and status**: the incident title in bold, then `INC-0001 - advised`.
2. **Fields**: Severity, Service, Source (`connector id (type)`) and Status.
3. **Diagnosis** (when there is one): category, confidence and the hypothesis, clipped.
4. **Recommendations** (when there are any): one line per step, from the catalog, at most 10 plus `(N more)`:

   ```
   Tier 3 - rollback_deployment on deployment/checkout-api - recommended, not executed (would require human approval)
   Tier 2 - add_incident_note on incident/checkout-api - recommended, not executed (shadow mode)
   Tier 4 - run_arbitrary_command on host/checkout-api - blocked (forbidden by construction)
   ```

5. **Context**: `Shadow mode: nothing was executed.`
6. **Links**: "Open incident" (needs `publicUrl`) and "Source alert", only when the URL is `http` or `https`.

Text that comes from alerts and from the model is escaped (`&`, `<` and `>` become `&amp;`, `&lt;` and `&gt;`), so a
title such as `<!channel> & <script>` shows as plain text and cannot ping the channel. Long texts are clipped to
Slack's limits (3000 characters per section, 2000 per field) without cutting an escape in half. The message is
redacted for secrets before it reaches the notifier.

## 4. Rate limits and retries

- Slack allows about one message per second per channel for incoming webhooks and answers `429` with a `Retry-After`
  header in seconds when you go over.
- The copilot sends at most four messages per incident, so a single incident does not reach the limit. Many incidents
  opened at once can, and the copilot retries once.
- The notification service waits for `Retry-After` (at most 10 seconds) and tries one more time on a `429`, a `5xx`
  or a network failure. Each attempt has a 5 second timeout. After that the failure is logged and dropped; messages
  are not queued.

## 5. When a send fails

The log line carries only a fixed `reason`; the URL and Slack's answer text never appear in it.

| `reason` | What happened | What to do |
|---|---|---|
| `rate limited` | Slack answered 429 | Nothing; the copilot already retried once |
| `http 5xx`, `unavailable`, `timed out` | Slack or the network failed | Nothing; the copilot already retried once |
| `invalid_token`, `no_service`, `no_service_id`, `no_active_hooks` | The webhook does not exist, was revoked or was disabled | Create a new webhook and rotate (below) |
| `channel_not_found`, `channel_is_archived`, `user_not_found` | The webhook's channel is gone | Create a webhook for a live channel |
| `action_prohibited`, `posting_to_general_channel_denied`, `no_team`, `team_disabled` | A workspace policy blocks the app | Ask a workspace admin |
| `invalid_payload`, `no_text`, `too_many_attachments` | Slack refused the body | A bug in the copilot: open an issue with the `reason` |
| `rejected` | Slack answered with text this guide does not list | Check the app in Slack |
| `unexpected response` | A 200 whose body was not `ok` (a proxy, for instance) | Check the network path to Slack |

Permanent errors are not retried.

## 6. Rotate a leaked or revoked URL

Slack revokes webhook URLs it finds posted publicly, and you can revoke one yourself. To replace it:

1. In your Slack app, **Incoming Webhooks**, add a new webhook for the same channel.
2. Set `SLACK_WEBHOOK_URL` to the new URL and restart the copilot (the config is read at start).
3. Remove the old webhook from the app's page, so a leaked copy stops working.
4. Search where the old URL may have been pasted (shell history, CI logs, tickets).

## Facts and sources

From <https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks>,
<https://docs.slack.dev/reference/block-kit/blocks/section-block> and
<https://docs.slack.dev/apis/web-api/rate-limits> (checked for 0.4.0):

- A webhook accepts a `POST` with `Content-type: application/json` and a body `{ "text": ..., "blocks": [...] }`.
  `text` is required (the error is `no_text`).
- Success is HTTP 200 with the plain-text body `ok`.
- Errors are 400, 403 or 404 with a plain string: `invalid_payload`, `no_text`, `no_service`, `no_service_id`,
  `no_active_hooks`, `invalid_token`, `action_prohibited`, `channel_is_archived`, `channel_not_found`,
  `user_not_found`, `no_team`, `team_disabled`, `posting_to_general_channel_denied`, `too_many_attachments`. The
  copilot does not retry `invalid_payload`, `action_prohibited` or the channel and user errors, and treats the rest of
  the list the same way.
- The channel, user name and icon of an incoming webhook cannot be overridden.
- The webhook URL is itself a secret.
- A section block's text is 1 to 3000 characters; its `fields` are at most 10, each at most 2000 characters; a
  `block_id` is at most 255 characters.
- Incoming webhooks allow about one message per second per channel; over that, Slack answers 429 with `Retry-After`
  in seconds.

## Unverified

Handled defensively, not relied upon:

- The maximum number of blocks per message: 50 is commonly cited but was not confirmed, so a message never has more
  than 6 blocks.
- The overall payload size limit: not confirmed. Every text is clipped, URLs longer than 1000 characters are dropped
  from links, and a message stays far below 40 KB.
- The incoming-webhook host of GovSlack and other Slack deployments: not confirmed, which is why `allowedHosts` is
  opt-in and an `https` host must be listed explicitly.
- The `mrkdwn` escaping of `&`, `<` and `>` follows <https://docs.slack.dev/messaging/formatting-message-text>, which
  was not re-read in this research. Other mrkdwn characters (`*`, `_`, backticks) are not neutralized: they can only
  change the look of a message, never mention or link anything.
- The wording of the Slack UI in section 1, and the statement that Slack revokes leaked webhook URLs: both come from
  general knowledge, not from the pages above.
- The text of the `429` body: the copilot relies on the status and `Retry-After` only.
