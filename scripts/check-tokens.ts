// check:tokens (spec 4.8): falha se houver cor literal (#rgb, #rrggbb, #rrggbbaa, rgb(, rgba(, hsl(, hsla() em
// web/src/**/*.{css,ts,tsx} fora de web/src/styles/tokens.css. Os testes da web (web/src/test) ficam de fora porque
// precisam de cores literais para conferir o cálculo de contraste.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { PROJECT_ROOT, projectPath } from "../src/infra/paths.ts";

const COLOR_LITERAL = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9A-Za-z_-])|\b(?:rgba?|hsla?)\(/g;
const EXTENSIONS = new Set([".css", ".ts", ".tsx"]);

export function findColorLiterals(text: string): string[] {
  return [...text.matchAll(COLOR_LITERAL)].map((m) => m[0]);
}

export type TokenViolation = { file: string; line: number; literal: string };

export function scanTokens(root = projectPath("web", "src")): TokenViolation[] {
  if (!existsSync(root)) return [];
  const skip = new Set([join(root, "styles", "tokens.css"), join(root, "test")]);
  const out: TokenViolation[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (skip.has(path)) continue;
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!EXTENSIONS.has(extname(name))) continue;
      readFileSync(path, "utf8").split("\n").forEach((text, i) => {
        for (const literal of findColorLiterals(text)) out.push({ file: relative(PROJECT_ROOT, path), line: i + 1, literal });
      });
    }
  };
  walk(root);
  return out;
}

if (import.meta.main) {
  const found = scanTokens();
  if (found.length > 0) {
    for (const v of found) process.stderr.write(`${v.file}:${v.line}: cor literal ${v.literal} (use um token de web/src/styles/tokens.css)\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("check:tokens: nenhuma cor literal fora de web/src/styles/tokens.css\n");
  }
}
