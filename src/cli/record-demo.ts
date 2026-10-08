// `record-demo [--out <dir>]` (spec 5.5 e 7.6): gera as gravações da War Room com os dois ramos (padrão web/public/demo).
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { recordAll } from "../app/demo-recorder.ts";
import { projectPath } from "../infra/paths.ts";
import type { CliIO } from "./io.ts";
import { UsageError } from "./io.ts";

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

export async function runRecordDemoCommand(argv: string[], io: CliIO): Promise<number> {
  let out: string | undefined;
  try {
    out = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { out: { type: "string" } } }).values.out;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const dir = out ? resolve(out) : projectPath("web", "public", "demo");
  const files = await recordAll(dir);
  io.out(`War Room recordings (${files.length} files):`);
  for (const f of files) {
    const shown = relative(process.cwd(), f.file) || f.file;
    io.out(`  ${shown.padEnd(48)} ${kb(f.bytes)}`);
  }
  return 0;
}
