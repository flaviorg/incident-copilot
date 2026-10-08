// `scenarios`: lista os cenários de demo.
import { loadConfig } from "../config.ts";
import { createContainer } from "../app/container.ts";
import { renderTable } from "./render.ts";
import type { CliIO } from "./io.ts";
import { UsageError } from "./io.ts";

export async function runScenariosCommand(argv: string[], io: CliIO): Promise<number> {
  if (argv.length > 0) throw new UsageError("the scenarios command takes no arguments");
  const config = loadConfig({ ...io.env, DB_PATH: ":memory:" }, { forceFake: true });
  const c = createContainer(config);
  try {
    const rows = c.scenarios.list().map((s) => [s.id, s.service ?? `account ${s.account ?? "?"}`, s.severity, s.summary]);
    io.out(renderTable(["id", "service", "severity", "summary"], rows));
    return 0;
  } finally {
    c.close();
  }
}
