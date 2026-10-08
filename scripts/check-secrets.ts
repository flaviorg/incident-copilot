// check:secrets (spec 6.6; AC-41): varre a árvore do projeto atrás de chaves e tokens. Não lista os arquivos com
// `git ls-files`, porque a pasta ainda vive dentro do repositório do curso; o Git só é consultado para saber se um `.env`
// local está rastreado. Roda no pre-commit e no CI. Nunca imprime o valor achado: só caminho, linha e o nome do padrão.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PROJECT_ROOT } from "../src/infra/paths.ts";

/**
 * Chave do OpenRouter, chave no formato `sk-` e atribuição de APPROVAL_TOKEN com valor de 8 caracteres ou mais.
 * O terceiro é montado por concatenação, para este arquivo não casar com o próprio padrão.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-or-v1-[A-Za-z0-9]{20,}/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
  new RegExp("APPROVAL_TOKEN" + "=\\S{8,}", "g"),
];

const PATTERN_NAMES = ["chave do OpenRouter", "chave sk-", "APPROVAL_TOKEN com valor"];

export type SecretFinding = { path: string; line: number; pattern: string };

export function scanText(text: string, path: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  text.split("\n").forEach((content, i) => {
    SECRET_PATTERNS.forEach((re, k) => {
      const hits = [...content.matchAll(new RegExp(re.source, "g"))].length;
      for (let n = 0; n < hits; n++) out.push({ path, line: i + 1, pattern: PATTERN_NAMES[k]! });
    });
  });
  return out;
}

/** Pastas ignoradas em qualquer nível. */
const IGNORED_DIRS = new Set(["node_modules", ".git", "coverage"]);
/** Caminhos ignorados a partir da raiz (com `/`). */
const IGNORED_PATHS = new Set(["reports", "web/dist", "web/public/demo", "coverage"]);
const isIgnoredFile = (rel: string) => /^data\/[^/]*\.db/.test(rel);
/**
 * Arquivo de ambiente local, fora do commit pelo `.gitignore` (padrão `.env`, em qualquer nível). É onde o README manda
 * pôr a chave real ("Usando um modelo real"), então varrê-lo quebraria o pre-commit de quem segue o README. Só entra na
 * varredura se estiver rastreado pelo Git. `.env.example` continua sendo varrido.
 */
const LOCAL_ENV_FILES = new Set([".env"]);

export type ScanOptions = {
  /** Diz se o caminho relativo (com `/`) está rastreado pelo Git. Padrão: `git ls-files --error-unmatch`. */
  isTracked?: (rel: string) => boolean;
};

/** `true` só quando o Git confirma que o arquivo está no índice; sem Git ou fora de um repositório, `false`. */
function trackedByGit(root: string, rel: string): boolean {
  const r = spawnSync("git", ["ls-files", "--error-unmatch", "--", rel], { cwd: root, stdio: "ignore" });
  return r.status === 0;
}

/** Percorre a árvore a partir de `root` e devolve os arquivos, como `join(root, caminho)`, em ordem estável. */
export function listProjectFiles(root: string, opts: ScanOptions = {}): string[] {
  const isTracked = opts.isTracked ?? ((rel: string) => trackedByGit(root, rel));
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(root, path).split(sep).join("/");
      const st = statSync(path);
      if (st.isDirectory()) {
        if (IGNORED_DIRS.has(name) || IGNORED_PATHS.has(rel)) continue;
        walk(path);
      } else if (st.isFile() && !isIgnoredFile(rel)) {
        if (LOCAL_ENV_FILES.has(name) && !isTracked(rel)) continue;
        out.push(join(root, rel));
      }
    }
  };
  walk(root);
  return out;
}

/** Arquivo binário (byte nulo nos primeiros 8 KB) fica de fora da varredura de texto. */
function readText(path: string): string | null {
  const buf = readFileSync(path);
  return buf.subarray(0, 8192).includes(0) ? null : buf.toString("utf8");
}

export function scanProject(root = PROJECT_ROOT, opts: ScanOptions = {}): { files: number; findings: SecretFinding[] } {
  const findings: SecretFinding[] = [];
  let files = 0;
  for (const file of listProjectFiles(root, opts)) {
    const text = readText(file);
    if (text === null) continue;
    files += 1;
    findings.push(...scanText(text, relative(root, file).split(sep).join("/")));
  }
  return { files, findings };
}

if (import.meta.main) {
  const { files, findings } = scanProject();
  if (findings.length > 0) {
    for (const f of findings) process.stderr.write(`${f.path}:${f.line}: possível segredo (${f.pattern}); valor omitido\n`);
    process.stderr.write(`check:secrets: ${findings.length} ocorrência(s) em ${files} arquivo(s) de texto\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`check:secrets: nenhum segredo em ${files} arquivo(s) de texto\n`);
  }
}
