import * as z from "zod";
import { MetricWindowSchema } from "../contracts/index.ts";
import { formatNumberPt, formatTs, hhmm, windowSeconds } from "./format.ts";
import { NO_DATA } from "./registry.ts";
import type { Tool } from "./registry.ts";

const Params = z.object({
  service: z.string().min(1).describe("Serviço cujos logs serão lidos"),
  level: z.enum(["ERROR", "WARN"]).describe("Nível mínimo de interesse"),
  window: MetricWindowSchema.describe("Janela que termina agora"),
  limit: z.number().int().min(1).max(5).optional().describe("Máximo de grupos de mensagem (padrão 3)"),
});

const MAX_MESSAGE = 160;

export function createQueryLogsTool(): Tool<z.infer<typeof Params>> {
  return {
    name: "query_logs",
    description: "Use para ver as mensagens de erro ou aviso mais frequentes de um serviço, agrupadas, com contagem e versões.",
    paramsSchema: Params,
    run({ service, level, window, limit = 3 }, { scenario, now }) {
      const ofService = scenario.logs.filter((l) => l.service === service);
      if (ofService.length === 0) return { ok: false, summary: `${NO_DATA}: ${service}`, evidenceRef: null };
      const toMs = now.getTime();
      const fromMs = toMs - windowSeconds(window) * 1000;
      const fromIso = new Date(fromMs).toISOString();
      const toIso = now.toISOString();
      const inWindow = ofService.filter((l) => {
        const t = Date.parse(l.ts);
        return l.level === level && t >= fromMs && t <= toMs;
      });
      const long = windowSeconds(window) > 3600;
      const evidenceRef = `logs:${service}:${level}@${hhmm(fromIso, long)}-${hhmm(toIso, long)}`;
      if (inWindow.length === 0) {
        return { ok: true, summary: `nenhuma linha ${level} de ${service} na janela de ${window}`, evidenceRef, data: { groups: [] } };
      }
      const groups = new Map<string, { message: string; count: number; versions: Set<string>; firstTs: string }>();
      for (const l of inWindow) {
        const g = groups.get(l.message) ?? { message: l.message, count: 0, versions: new Set<string>(), firstTs: l.ts };
        g.count += l.count;
        g.versions.add(l.version);
        if (l.ts < g.firstTs) g.firstTs = l.ts;
        groups.set(l.message, g);
      }
      const sorted = [...groups.values()].sort((a, b) => b.count - a.count || a.firstTs.localeCompare(b.firstTs));
      const shown = sorted.slice(0, limit);
      const total = sorted.reduce((a, g) => a + g.count, 0);
      const parts = shown.map((g) => {
        const msg = g.message.length > MAX_MESSAGE ? g.message.slice(0, MAX_MESSAGE - 1) + "…" : g.message;
        return `[${formatNumberPt(g.count, 0)}x, versões ${[...g.versions].sort().join(", ")}, desde ${formatTs(g.firstTs, long)}] ${msg}`;
      });
      const summary = `${formatNumberPt(total, 0)} linhas ${level} de ${service} em ${window}, ${sorted.length} grupo(s); mais frequentes: ${parts.join(" | ")}`;
      return {
        ok: true,
        summary,
        evidenceRef,
        data: { groups: shown.map((g) => ({ message: g.message, count: g.count, versions: [...g.versions].sort(), firstTs: g.firstTs })) },
      };
    },
  };
}
