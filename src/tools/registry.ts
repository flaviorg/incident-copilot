// Read tools (tier 1) with Zod parameters and short output (spec 4.3). They never write state.
// `run` never throws: an unknown tool, invalid argument or failure becomes an observation with ok: false.
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
  description: string; // usage-oriented description
  paramsSchema: z.ZodType<P>;
  run(params: P, ctx: ToolContext): ToolResult;
}

export interface ToolRegistry {
  names(): ReadToolName[];
  /** Name, usage-oriented description and JSON Schema of the parameters. */
  describeForPrompt(): string;
  run(name: string, args: unknown, ctx: ToolContext): ToolResult;
}

const MAX_OBSERVATION_CHARS = 600;
const TRUNCATED_SUFFIX = " (truncated)";

export function truncateSummary(text: string, max = MAX_OBSERVATION_CHARS): string {
  if (text.length <= max) return text;
  return text.slice(0, max - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX;
}

/** Scenario scope: the alert's service or, without a service, the account. */
export function scenarioScope(s: LoadedScenario): string | null {
  return s.file.service ?? s.file.account;
}

export const NO_DATA = "no data for this service in this scenario";

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
      tools.map((t) => `- ${t.name}: ${t.description}\n  parameters (JSON Schema): ${JSON.stringify(z.toJSONSchema(t.paramsSchema))}`).join("\n"),
    run(name, args, ctx) {
      const tool = byName.get(name);
      if (!tool) {
        return { ok: false, summary: truncateSummary(`unknown tool: ${name}. Available: ${[...byName.keys()].join(", ")}`), evidenceRef: null };
      }
      const parsed = parseWithIssues(tool.paramsSchema, args);
      if (!parsed.success) {
        return { ok: false, summary: truncateSummary(`invalid arguments for ${name}: ${formatIssues(parsed.issues)}`), evidenceRef: null };
      }
      try {
        const r = tool.run(parsed.data, ctx);
        return { ...r, summary: truncateSummary(r.summary) };
      } catch (e) {
        return { ok: false, summary: truncateSummary(`failed to run ${name}: ${(e as Error).message}`), evidenceRef: null };
      }
    },
  };
}
