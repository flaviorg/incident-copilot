// Alertmanager connector config (docs/connectors/alertmanager.md). Alertmanager does not sign its payloads, so the
// receiver authenticates with http_config.authorization (Bearer) or basic_auth.
import * as z from "zod";
import type { Severity } from "../../contracts/index.ts";
import type { ConfigHelpers } from "../shared/config-helpers.ts";
import { webhookAuthSchema } from "../shared/auth.ts";

export function alertmanagerConfigSchema(h: ConfigHelpers) {
  const label = h.text({ max: 100 });
  return z.strictObject({
    ingest: z.strictObject({ auth: webhookAuthSchema(h, ["bearer", "basic"]) }).optional(),
    /** Label that names the service; the fallbacks are tried in order when it is missing. */
    serviceLabel: label.default("service"),
    fallbackServiceLabels: z.array(label).max(10).default(["job"]),
    titleAnnotation: label.default("summary"),
    severityLabel: label.default("severity"),
  });
}

export type AlertmanagerConfig = z.infer<ReturnType<typeof alertmanagerConfigSchema>>;

/** Used when the copilot.yaml entry has no severityMap. */
export const DEFAULT_ALERTMANAGER_SEVERITY: Readonly<Record<string, Severity>> = { critical: "sev1", error: "sev2", warning: "sev2", info: "sev3" };
