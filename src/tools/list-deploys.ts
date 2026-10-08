import * as z from "zod";
import { formatMinutes, formatTs, hhmm } from "./format.ts";
import { NO_DATA } from "./registry.ts";
import type { Tool } from "./registry.ts";

const Params = z.object({
  service: z.string().min(1).describe("Service whose deploys will be listed"),
  sinceMinutes: z.number().int().min(1).max(10080).optional().describe("How many minutes to look back (default 10080, 7 days)"),
});

const minutesBetween = (fromIso: string, to: Date) => Math.round((to.getTime() - Date.parse(fromIso)) / 60000);

export function createListDeploysTool(): Tool<z.infer<typeof Params>> {
  return {
    name: "list_deploys",
    description: "Use to correlate the onset of a problem with recent deploys of the service and to learn the previous version.",
    paramsSchema: Params,
    run({ service, sinceMinutes = 10080 }, { scenario, world, now }) {
      const ofService = scenario.deploys.filter((d) => d.service === service);
      const running = world.deployments[service];
      if (ofService.length === 0 && !running) return { ok: false, summary: `${NO_DATA}: ${service}`, evidenceRef: null };
      const fromMs = now.getTime() - sinceMinutes * 60000;
      const recent = ofService
        .filter((d) => Date.parse(d.at) >= fromMs && Date.parse(d.at) <= now.getTime())
        .sort((a, b) => b.at.localeCompare(a.at));
      const runningText = running ? ` Version running now: ${running.version} (${running.replicas} replicas).` : "";
      const evidenceRef = `deploys:${service}@${hhmm(now.toISOString())}`;
      if (recent.length === 0) {
        return { ok: true, summary: `no deploy of ${service} in the last ${formatMinutes(sinceMinutes)}.${runningText}`, evidenceRef, data: { deploys: [] } };
      }
      const parts = recent.map(
        (d) => `${d.version} at ${formatTs(d.at, true)} UTC, ${minutesBetween(d.at, now)} min ago (previous ${d.previousVersion}, ${d.replicas} replicas)`,
      );
      return {
        ok: true,
        summary: `${recent.length} ${recent.length === 1 ? "deploy" : "deploys"} of ${service} in the last ${formatMinutes(sinceMinutes)}, most recent first: ${parts.join("; ")}.${runningText}`,
        evidenceRef,
        data: { deploys: recent },
      };
    },
  };
}
