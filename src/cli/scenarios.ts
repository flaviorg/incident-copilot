// `scenarios`: lista os cenários de demo.
import { loadConfig } from "../config.ts";
import { createContainer } from "../app/container.ts";
import { renderTable } from "./render.ts";
import type { CliIO } from "./io.ts";
import { UsageError } from "./io.ts";

export async function runScenariosCommand(argv: string[], io: CliIO): Promise<number> {
  if (argv.length > 0) throw new UsageError("o comando scenarios não aceita argumentos");
  const config = loadConfig({ ...io.env, DB_PATH: ":memory:" }, { forceFake: true });
  const c = createContainer(config);
  try {
    const rows = c.scenarios.list().map((s) => [s.id, s.service ?? `conta ${s.account ?? "?"}`, s.severity, s.summary]);
    io.out(renderTable(["id", "serviço", "severidade", "resumo"], rows));
    return 0;
  } finally {
    c.close();
  }
}
