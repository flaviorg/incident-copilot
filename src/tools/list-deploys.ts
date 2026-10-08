import * as z from "zod";
import { formatMinutes, formatTs, hhmm } from "./format.ts";
import { NO_DATA } from "./registry.ts";
import type { Tool } from "./registry.ts";

const Params = z.object({
  service: z.string().min(1).describe("Serviço cujos deploys serão listados"),
  sinceMinutes: z.number().int().min(1).max(10080).optional().describe("Quantos minutos para trás olhar (padrão 10080, 7 dias)"),
});

const minutesBetween = (fromIso: string, to: Date) => Math.round((to.getTime() - Date.parse(fromIso)) / 60000);

export function createListDeploysTool(): Tool<z.infer<typeof Params>> {
  return {
    name: "list_deploys",
    description: "Use para correlacionar o início de um problema com deploys recentes do serviço e saber a versão anterior.",
    paramsSchema: Params,
    run({ service, sinceMinutes = 10080 }, { scenario, world, now }) {
      const ofService = scenario.deploys.filter((d) => d.service === service);
      const running = world.deployments[service];
      if (ofService.length === 0 && !running) return { ok: false, summary: `${NO_DATA}: ${service}`, evidenceRef: null };
      const fromMs = now.getTime() - sinceMinutes * 60000;
      const recent = ofService
        .filter((d) => Date.parse(d.at) >= fromMs && Date.parse(d.at) <= now.getTime())
        .sort((a, b) => b.at.localeCompare(a.at));
      const runningText = running ? ` Versão em execução agora: ${running.version} (${running.replicas} réplicas).` : "";
      const evidenceRef = `deploys:${service}@${hhmm(now.toISOString())}`;
      if (recent.length === 0) {
        return { ok: true, summary: `nenhum deploy de ${service} nos últimos ${formatMinutes(sinceMinutes)}.${runningText}`, evidenceRef, data: { deploys: [] } };
      }
      const parts = recent.map(
        (d) => `${d.version} em ${formatTs(d.at, true)} UTC, ${minutesBetween(d.at, now)} min atrás (anterior ${d.previousVersion}, ${d.replicas} réplicas)`,
      );
      return {
        ok: true,
        summary: `${recent.length} deploy(s) de ${service} nos últimos ${formatMinutes(sinceMinutes)}, do mais recente: ${parts.join("; ")}.${runningText}`,
        evidenceRef,
        data: { deploys: recent },
      };
    },
  };
}
