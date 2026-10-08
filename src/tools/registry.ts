// Ferramentas de leitura (faixa 1) com parâmetros Zod e saída curta (spec 4.3). Nunca escrevem estado.
// `run` nunca lança: ferramenta desconhecida, argumento inválido ou falha viram observação com ok: false.
import * as z from "zod";
import type { ReadToolName, WorldState } from "../contracts/index.ts";
import type { LoadedScenario } from "../infra/scenarios/scenario-loader.ts";
import type { CloudPrices } from "../domain/finops/inventory-audit.ts";
import { formatIssues, parseWithIssues } from "../domain/validation.ts";
import { createQueryMetricsTool } from "./query-metrics.ts";
import { createQueryLogsTool } from "./query-logs.ts";
import { createListDeploysTool } from "./list-deploys.ts";
import { createAuditCloudInventoryTool } from "./audit-cloud-inventory.ts";

export type ToolContext = { scenario: LoadedScenario; world: WorldState; now: Date };
export type ToolResult = { ok: boolean; summary: string; evidenceRef: string | null; data?: unknown };

export interface Tool<P> {
  name: ReadToolName;
  description: string; // descrição orientada a uso
  paramsSchema: z.ZodType<P>;
  run(params: P, ctx: ToolContext): ToolResult;
}

export interface ToolRegistry {
  names(): ReadToolName[];
  /** Nome, descrição orientada a uso e JSON Schema dos parâmetros. */
  describeForPrompt(): string;
  run(name: string, args: unknown, ctx: ToolContext): ToolResult;
}

const MAX_OBSERVATION_CHARS = 600;
const TRUNCATED_SUFFIX = " (truncado)";

export function truncateSummary(text: string, max = MAX_OBSERVATION_CHARS): string {
  if (text.length <= max) return text;
  return text.slice(0, max - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX;
}

/** Escopo do cenário: o serviço do alerta ou, sem serviço, a conta. */
export function scenarioScope(s: LoadedScenario): string | null {
  return s.file.service ?? s.file.account;
}

export const NO_DATA = "serviço sem dados neste cenário";

export function createToolRegistry(o: { prices: CloudPrices }): ToolRegistry {
  const tools: Tool<unknown>[] = [
    createQueryMetricsTool() as Tool<unknown>,
    createQueryLogsTool() as Tool<unknown>,
    createListDeploysTool() as Tool<unknown>,
    createAuditCloudInventoryTool({ prices: o.prices }) as Tool<unknown>,
  ];
  const byName = new Map(tools.map((t) => [t.name as string, t]));

  return {
    names: () => tools.map((t) => t.name),
    describeForPrompt: () =>
      tools.map((t) => `- ${t.name}: ${t.description}\n  parâmetros (JSON Schema): ${JSON.stringify(z.toJSONSchema(t.paramsSchema))}`).join("\n"),
    run(name, args, ctx) {
      const tool = byName.get(name);
      if (!tool) {
        return { ok: false, summary: truncateSummary(`ferramenta desconhecida: ${name}. Disponíveis: ${[...byName.keys()].join(", ")}`), evidenceRef: null };
      }
      const parsed = parseWithIssues(tool.paramsSchema, args);
      if (!parsed.success) {
        return { ok: false, summary: truncateSummary(`argumentos inválidos para ${name}: ${formatIssues(parsed.issues)}`), evidenceRef: null };
      }
      try {
        const r = tool.run(parsed.data, ctx);
        return { ...r, summary: truncateSummary(r.summary) };
      } catch (e) {
        return { ok: false, summary: truncateSummary(`falha ao executar ${name}: ${(e as Error).message}`), evidenceRef: null };
      }
    },
  };
}
