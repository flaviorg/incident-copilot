// Entrada da CLI: despacha argv[2] para src/cli/<comando>.ts. Códigos de saída (spec 5.5):
// 0 sucesso, 1 erro, 2 problema de fixture (UnscriptedLlmCallError, FixturePromptDriftError).
import { collectSecrets, redactSecrets } from "./infra/redact.ts";
import { ConfigError } from "./config.ts";
import { FixturePromptDriftError, NotFoundError, UnscriptedLlmCallError, ValidationError } from "./domain/errors.ts";
import type { CliIO } from "./cli/io.ts";
import { UsageError } from "./cli/io.ts";

type Command = (argv: string[], io: CliIO) => Promise<number>;

const COMMANDS: Record<string, { help: string; load: () => Promise<Command> }> = {
  scenarios: { help: "scenarios                                      lista os cenários de demo", load: async () => (await import("./cli/scenarios.ts")).runScenariosCommand },
  tool: { help: "tool <nome> --scenario <id> [--args '<json>']  executa uma ferramenta de leitura", load: async () => (await import("./cli/tool.ts")).runToolCommand },
  demo: { help: "demo [--scenario <id>] [--reject] [--persist] [--json] [--live]  cenário completo com aprovação do operador demo", load: async () => (await import("./cli/demo.ts")).runDemoCommand },
  diagnose: { help: "diagnose --scenario <id>                       só o analista de telemetria (ReAct) e o diagnóstico", load: async () => (await import("./cli/diagnose.ts")).runDiagnoseCommand },
  "record-demo": { help: "record-demo [--out <dir>]                      gera as gravações da War Room (padrão web/public/demo)", load: async () => (await import("./cli/record-demo.ts")).runRecordDemoCommand },
};

const USAGE = [
  "uso: node src/cli.ts <comando> [opções]",
  "",
  "comandos:",
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
    io.err(name ? `comando desconhecido: ${name}\n\n${USAGE}` : USAGE);
    return 1;
  }
  try {
    return await (await command.load())(rest, io);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`erro: ${e.message}\n\n${USAGE}`);
      return 1;
    }
    if (e instanceof UnscriptedLlmCallError || e instanceof FixturePromptDriftError) {
      io.err(`erro de fixture: ${e.message}`);
      return 2;
    }
    if (e instanceof ConfigError || e instanceof ValidationError || e instanceof NotFoundError) {
      io.err(`erro: ${e.message}`);
      return 1;
    }
    io.err(`erro inesperado: ${(e as Error)?.message ?? String(e)}`);
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
