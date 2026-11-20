// The body of the generic outbound webhook (spec 008, AC-56; docs/connectors/outbound-webhook.md): the notification
// message, already redacted, under a schema version. Pure.
import type { NotificationMessage } from "../types.ts";

export const OUTBOUND_SCHEMA_VERSION = 1;

export function renderOutbound(m: NotificationMessage): string {
  return JSON.stringify({ schemaVersion: OUTBOUND_SCHEMA_VERSION, ...m });
}
