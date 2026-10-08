// `tool <nome> --scenario <id> [--args '<json>']`: executa uma ferramenta determinística de leitura.
// Usa como "agora" o detectedAt do cenário e o mundo inicial do cenário.
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { createContainer } from "../app/container.ts";
import { renderToolResult } from "./render.ts";
import type { CliIO } from "./io.ts";
import { UsageError } from "./io.ts";

export async function runToolCommand(argv: string[], io: CliIO): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const name = parsed.positionals[0];
  if (!name || parsed.positionals.length > 1) throw new UsageError("name exactly one tool: tool <name> --scenario <id> [--args '<json>']");
  const scenarioId = parsed.values.scenario;
  if (!scenarioId) throw new UsageError("missing --scenario <id>");
  let args: unknown;
  try {
    args = JSON.parse(parsed.values.args ?? "{}");
  } catch {
    throw new UsageError("--args must be valid JSON, for example '{\"account\":\"data-platform\"}'");
  }

  const config = loadConfig({ ...io.env, DB_PATH: ":memory:" }, { forceFake: true });
  const c = createContainer(config);
  try {
    const scenario = c.scenarios.get(scenarioId);
    const now = new Date(scenario.alert.detectedAt);
    const result = c.tools.run(name, args, { scenario, world: c.infra.initialWorld(scenario), now });
    io.out(renderToolResult({ name, scenarioId, now: now.toISOString(), result }));
    return result.ok ? 0 : 1;
  } finally {
    c.close();
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: { scenario: { type: "string" }, args: { type: "string" } },
  });
}
