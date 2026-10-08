import * as z from "zod";
import { MetricWindowSchema } from "../contracts/index.ts";
import { formatNumber, formatTs, hhmm, windowSeconds } from "./format.ts";
import { NO_DATA } from "./registry.ts";
import type { Tool } from "./registry.ts";

const Params = z.object({
  service: z.string().min(1).describe("Service whose logs will be read"),
  level: z.enum(["ERROR", "WARN"]).describe("Minimum level of interest"),
  window: MetricWindowSchema.describe("Window ending now"),
  limit: z.number().int().min(1).max(5).optional().describe("Maximum number of message groups (default 3)"),
});

const MAX_MESSAGE = 160;

export function createQueryLogsTool(): Tool<z.infer<typeof Params>> {
  return {
    name: "query_logs",
    description: "Use to see a service's most frequent error or warning messages, grouped, with counts and versions.",
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
        return { ok: true, summary: `no ${level} lines for ${service} in the ${window} window`, evidenceRef, data: { groups: [] } };
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
        return `[${formatNumber(g.count, 0)}x, versions ${[...g.versions].sort().join(", ")}, since ${formatTs(g.firstTs, long)}] ${msg}`;
      });
      const summary = `${formatNumber(total, 0)} ${level} lines for ${service} over ${window}, ${sorted.length} ${sorted.length === 1 ? "group" : "groups"}; most frequent: ${parts.join(" | ")}`;
      return {
        ok: true,
        summary,
        evidenceRef,
        data: { groups: shown.map((g) => ({ message: g.message, count: g.count, versions: [...g.versions].sort(), firstTs: g.firstTs })) },
      };
    },
  };
}
