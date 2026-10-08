// Processos filhos dos testes (CLI e servidor MCP), com a rede bloqueada também no filho (AC-27) e sem herdar o
// ambiente (só PATH e HOME).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Argumentos do node em todo filho de teste: o mesmo bloqueio de fetch do processo de teste. */
export const CHILD_NODE_ARGS: readonly string[] = ["--import", "./tests/setup/no-network.ts"];

export type ChildResult = { code: number; stdout: string; stderr: string; ms: number };

/** `node <CHILD_NODE_ARGS> <args>` na raiz do projeto. */
export function runNode(args: string[], env: Record<string, string> = {}): Promise<ChildResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...CHILD_NODE_ARGS, ...args], {
      cwd: PROJECT_ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr, ms: Date.now() - started }));
  });
}

export function runCli(args: string[], env: Record<string, string> = {}): Promise<ChildResult> {
  return runNode(["src/cli.ts", ...args], env);
}
