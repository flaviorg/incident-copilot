// Entrada da CLI: despacha argv[2] para src/cli/<comando>.ts. Códigos de saída (spec 5.5):
// 0 sucesso, 1 erro, 2 problema de fixture (UnscriptedLlmCallError, FixturePromptDriftError).
import { collectSecrets, redactSecrets } from "./infra/redact.ts";
import { ConfigError } from "./config.ts";
import { FixturePromptDriftError, NotFoundError, UnscriptedLlmCallError, ValidationError } from "./domain/errors.ts";
import type { CliIO } from "./cli/io.ts";
import { UsageError } from "./cli/io.ts";

type Command = (argv: string[], io: CliIO) => Promise<number>;

const COMMANDS: Record<string, { help: string; load: () => Promise<Command> }> = {
  scenarios: { help: "scenarios                                      lists the demo scenarios", load: async () => (await import("./cli/scenarios.ts")).runScenariosCommand },
  tool: { help: "tool <name> --scenario <id> [--args '<json>']  runs a read-only tool", load: async () => (await import("./cli/tool.ts")).runToolCommand },
  demo: { help: "demo [--scenario <id>] [--reject] [--persist] [--json] [--live]  full scenario with approval by the demo operator", load: async () => (await import("./cli/demo.ts")).runDemoCommand },
  diagnose: { help: "diagnose --scenario <id>                       only the telemetry analyst (ReAct) and the diagnosis", load: async () => (await import("./cli/diagnose.ts")).runDiagnoseCommand },
  "record-demo": { help: "record-demo [--out <dir>]                      generates the War Room recordings (default web/public/demo)", load: async () => (await import("./cli/record-demo.ts")).runRecordDemoCommand },
};

const USAGE = [
  "usage: node src/cli.ts <command> [options]",
  "",
  "commands:",
  ...Object.values(COMMANDS).map((c) => `  ${c.help}`),
].join("\n");

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  const secrets = collectSecrets({ approvalToken: env.APPROVAL_TOKEN ?? null, openrouterApiKey: env.OPENROUTER_API_KEY ?? null });
  const io: CliIO = {
    env,
    out: (t) => void process.stdout.write(redactSecrets(t, secrets) + "\n"),
    err: (t) => void process.stderr.write(redactSecrets(t, secrets) + "\n"),
  };
  const [name, ...rest] = argv;
  const command = name ? COMMANDS[name] : undefined;
  if (!command) {
    io.err(name ? `unknown command: ${name}\n\n${USAGE}` : USAGE);
    return 1;
  }
  try {
    return await (await command.load())(rest, io);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}\n\n${USAGE}`);
      return 1;
    }
    if (e instanceof UnscriptedLlmCallError || e instanceof FixturePromptDriftError) {
      io.err(`fixture error: ${e.message}`);
      return 2;
    }
    if (e instanceof ConfigError || e instanceof ValidationError || e instanceof NotFoundError) {
      io.err(`error: ${e.message}`);
      return 1;
    }
    io.err(`unexpected error: ${(e as Error)?.message ?? String(e)}`);
    return 1;
  }
}

if (import.meta.main) {
  // Leitor que fecha o pipe antes do fim (ex.: `| head`): encerra em silêncio, como as ferramentas de terminal.
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(0);
    throw e;
  });
  process.exitCode = await main(process.argv.slice(2), process.env);
}
