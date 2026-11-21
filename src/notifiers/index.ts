// The only list of registered notifier types. Packages export their definition; the integration task appends here.
import type { NotifierDefinition } from "./types.ts";
import { slackNotifier } from "./slack/index.ts";
import { outboundWebhookNotifier } from "./outbound-webhook/index.ts";

export const NOTIFIER_DEFINITIONS: readonly NotifierDefinition<unknown>[] = [slackNotifier, outboundWebhookNotifier];
