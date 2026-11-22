// `config check [--file <path>]` (spec 008, AC-51): validates copilot.yaml with the registered connector and notifier
// types and prints a summary. Exit 0 when valid, 1 otherwise. Never prints a value: problems are { path, rule } and the
// resolved secrets join the redaction list before anything is printed.
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { draftPrProblems, loadCopilotConfigFile } from "../infra/copilot-config/load.ts";
import { CONNECTOR_DEFINITIONS } from "../connectors/index.ts";
import { NOTIFIER_DEFINITIONS } from "../notifiers/index.ts";
import { createConnectorRegistry } from "../connectors/registry.ts";
import { createLogger } from "../infra/logger.ts";
import type { CliIO } from "./io.ts";
import { UsageError } from "./io.ts";

const DEFAULT_FILE = "./copilot.yaml";

/** Building the registry performs no I/O; this transport makes sure nothing is sent anyway. */
const noFetch = (async () => {
  throw new Error("config check performs no network calls");
}) as typeof fetch;

export async function runConfigCommand(argv: string[], io: CliIO): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const [sub, ...extra] = parsed.positionals;
  if (sub !== "check" || extra.length > 0) throw new UsageError("use: config check [--file <path>]");
  const fromEnv = io.env.COPILOT_CONFIG?.trim();
  const file = parsed.values.file ?? (fromEnv ? fromEnv : DEFAULT_FILE);

  const r = loadCopilotConfigFile(resolve(file), { env: io.env, connectors: CONNECTOR_DEFINITIONS, notifiers: NOTIFIER_DEFINITIONS });
  // The rule npm start applies (assertLiveSafe): a draft_pr code fixer needs APPROVAL_TOKEN.
  const problems = r.ok ? draftPrProblems(io.env.APPROVAL_TOKEN, r.config) : r.problems;
  if (!r.ok || problems.length > 0) {
    io.err(`copilot config invalid: ${problems.length} problem(s) in ${file}`);
    for (const p of problems) io.err(`- ${p.path || "(file)"}: ${p.rule}`);
    return 1;
  }
  const c = r.config;
  io.addSecrets?.(c.secrets);
  const registry = createConnectorRegistry({
    definitions: CONNECTOR_DEFINITIONS, entries: c.connectors, fetch: noFetch, now: () => new Date(),
    logger: createLogger({ level: "error", secrets: c.secrets, write: () => {} }),
  });
  try {
    const live = new Map(registry.list().map((x) => [x.id, x]));
    io.out(`copilot config OK: ${file}`);
    io.out(`mode: ${c.mode} (nothing executes; tier 3 steps are recorded as recommendations)`);
    io.out(`publicUrl: ${c.publicUrl ?? "none"}`);
    io.out(`connectors: ${c.connectors.length}`);
    for (const e of c.connectors) {
      const i = live.get(e.id);
      if (!i) {
        io.out(`  - ${e.id} (${e.type}): disabled`);
        continue;
      }
      io.out(`  - ${e.id} (${e.type}): capabilities ${i.capabilities.join(", ") || "none"}; ingest path ${i.ingestPath ?? "none"}`);
    }
    io.out(`notifiers: ${c.notifiers.length}`);
    for (const n of c.notifiers) io.out(`  - ${n.id} (${n.type}): events ${n.events.join(", ")}`);
    io.out(`services: ${c.services.length}`);
    const fix = c.codeFix;
    io.out(`codeFix: ${fix === null ? "none" : !fix.enabled ? "disabled" : `${fix.mode}; repositories ${fix.repositories.length}`}`);
    return 0;
  } finally {
    await registry.close();
  }
}

function parse(argv: string[]) {
  return parseArgs({ args: argv, allowPositionals: true, strict: true, options: { file: { type: "string" } } });
}
