// Read tools (tier 1) with Zod parameters and short output (spec 4.3). They never write state.
// `run` never throws: an unknown tool, invalid argument or failure becomes an observation with ok: false.
// The tool set follows the incident context (spec 008, decision 3): a scenario gets the same 4 tools, descriptions and
// order as before 0.4 (frozen in tests/fixtures/tools/scenario-tools-description.txt); a live incident gets the live
// tools whose capability some configured source has.
import * as z from "zod";
import type { ReadToolName, WorldState } from "../contracts/index.ts";
import type { LoadedScenario } from "../infra/scenarios/scenario-loader.ts";
import type { CloudPrices } from "../domain/finops/inventory-audit.ts";
import { formatIssues, parseWithIssues } from "../domain/validation.ts";
import { createQueryMetricsTool } from "./query-metrics.ts";
import { createQueryLogsTool } from "./query-logs.ts";
import { createListDeploysTool } from "./list-deploys.ts";
import { createAuditCloudInventoryTool } from "./audit-cloud-inventory.ts";
import { createLiveTools, hasCapability } from "./live/live-tools.ts";
import type { LiveTool, LiveToolContext } from "./live/live-tools.ts";
import type { ToolContext } from "./context.ts";

export type { ToolContext } from "./context.ts";
export type ToolResult = { ok: boolean; summary: string; evidenceRef: string | null; data?: unknown };

/** What a scenario tool reads: the recorded scenario, the simulated world and the clock. */
export type ScenarioToolContext = { scenario: LoadedScenario; world: WorldState; now: Date };

export interface Tool<P> {
  name: ReadToolName;
  description: string; // usage-oriented description
  paramsSchema: z.ZodType<P>;
  run(params: P, ctx: ScenarioToolContext): Promise<ToolResult>;
}

export interface ToolRegistry {
  names(ctx: ToolContext): Promise<ReadToolName[]>;
  /** Name, usage-oriented description and JSON Schema of the parameters. */
  describeForPrompt(ctx: ToolContext): Promise<string>;
  run(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

const MAX_OBSERVATION_CHARS = 600;
const TRUNCATED_SUFFIX = " (truncated)";
/** Default per-source timeout of a live tool call (spec 008, AC-53). */
export const LIVE_TOOL_TIMEOUT_MS = 10_000;

export function truncateSummary(text: string, max = MAX_OBSERVATION_CHARS): string {
  if (text.length <= max) return text;
  return text.slice(0, max - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX;
}

/** Scenario scope: the alert's service or, without a service, the account. */
export function scenarioScope(s: LoadedScenario): string | null {
  return s.file.service ?? s.file.account;
}

export const NO_DATA = "no data for this service in this scenario";

const describeLine = (name: string, description: string, schema: z.ZodType) =>
  `- ${name}: ${description}\n  parameters (JSON Schema): ${JSON.stringify(z.toJSONSchema(schema))}`;

type Resolved = {
  names: ReadToolName[];
  describe(): Promise<string>;
  schemaOf(name: string): Promise<z.ZodType | null>;
  exec(name: string, params: unknown): Promise<ToolResult>;
};

export function createToolRegistry(o: { prices: CloudPrices; liveTimeoutMs?: number }): ToolRegistry {
  const tools: Tool<unknown>[] = [
    createQueryMetricsTool() as Tool<unknown>,
    createQueryLogsTool() as Tool<unknown>,
    createListDeploysTool() as Tool<unknown>,
    createAuditCloudInventoryTool({ prices: o.prices }) as Tool<unknown>,
  ];
  const byName = new Map(tools.map((t) => [t.name as string, t]));
  const liveTools = createLiveTools();

  const resolve = (ctx: ToolContext): Resolved => {
    const inc = ctx.incident;
    if (inc.kind === "scenario") {
      const sctx: ScenarioToolContext = { scenario: inc.scenario, world: ctx.world, now: ctx.now };
      return {
        names: tools.map((t) => t.name),
        describe: async () => tools.map((t) => describeLine(t.name, t.description, t.paramsSchema)).join("\n"),
        schemaOf: async (name) => byName.get(name)?.paramsSchema ?? null,
        exec: (name, params) => byName.get(name)!.run(params, sctx),
      };
    }
    const lctx: LiveToolContext = {
      sources: inc.sources, services: inc.services, incidentService: inc.incidentService, now: ctx.now,
      timeoutMs: o.liveTimeoutMs ?? LIVE_TOOL_TIMEOUT_MS, ...(ctx.signal ? { signal: ctx.signal } : {}),
    };
    const available = liveTools.filter((t) => inc.sources.some((s) => hasCapability(s.query, t.capability)));
    const find = (name: string): LiveTool<unknown> | undefined => available.find((t) => t.name === name);
    return {
      names: available.map((t) => t.name),
      describe: async () => {
        const lines: string[] = [];
        for (const t of available) {
          const d = await t.describe(lctx);
          lines.push(describeLine(t.name, d.description, d.paramsSchema));
        }
        return lines.join("\n");
      },
      schemaOf: async (name) => {
        const t = find(name);
        return t ? (await t.describe(lctx)).paramsSchema : null;
      },
      exec: (name, params) => find(name)!.run(params, lctx),
    };
  };

  return {
    names: async (ctx) => resolve(ctx).names,
    async describeForPrompt(ctx) {
      try {
        return await resolve(ctx).describe();
      } catch {
        return "";
      }
    },
    async run(name, args, ctx) {
      try {
        const r = resolve(ctx);
        const schema = (r.names as string[]).includes(name) ? await r.schemaOf(name) : null;
        if (!schema) {
          return { ok: false, summary: truncateSummary(`unknown tool: ${name}. Available: ${r.names.join(", ")}`), evidenceRef: null };
        }
        const parsed = parseWithIssues(schema, args);
        if (!parsed.success) {
          return { ok: false, summary: truncateSummary(`invalid arguments for ${name}: ${formatIssues(parsed.issues)}`), evidenceRef: null };
        }
        const res = await r.exec(name, parsed.data);
        return { ...res, summary: truncateSummary(res.summary) };
      } catch (e) {
        return { ok: false, summary: truncateSummary(`failed to run ${name}: ${(e as Error)?.message ?? "error"}`), evidenceRef: null };
      }
    },
  };
}
