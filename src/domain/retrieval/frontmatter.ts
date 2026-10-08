// Frontmatter num subconjunto restrito e testado (sem parser YAML): só "chave: valor" e "chave: [a, b]". Puro.

export class FrontmatterError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`invalid frontmatter at line ${line}: ${message}`);
    this.name = "FrontmatterError";
    this.line = line;
  }
}

const FENCE = "---";
const KEY_VALUE = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/;

function unquote(v: string): string {
  return v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) ? v.slice(1, -1) : v;
}

/** Sem cerca de abertura: devolve dados vazios e o texto inteiro como corpo. */
export function parseFrontmatter(md: string): { data: Record<string, string | string[]>; body: string } {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== FENCE) return { data: {}, body: md };
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === FENCE);
  if (close === -1) throw new FrontmatterError("missing closing --- fence", lines.length);

  const data: Record<string, string | string[]> = {};
  for (let i = 1; i < close; i++) {
    const lineNo = i + 1;
    const line = lines[i]!;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) throw new FrontmatterError("indented line (nested maps are not accepted)", lineNo);
    const m = KEY_VALUE.exec(line);
    if (!m) throw new FrontmatterError("esperava 'chave: valor'", lineNo);
    const key = m[1]!;
    const raw = m[2]!.trim();
    if (key in data) throw new FrontmatterError(`chave repetida: ${key}`, lineNo);
    if (raw.startsWith("{")) throw new FrontmatterError("nested maps are not accepted", lineNo);
    if (raw.startsWith("[")) {
      if (!raw.endsWith("]")) throw new FrontmatterError("list without a closing ]", lineNo);
      const inner = raw.slice(1, -1).trim();
      if (inner.includes("[") || inner.includes("{")) throw new FrontmatterError("nested lists are not accepted", lineNo);
      data[key] = inner === "" ? [] : inner.split(",").map((s) => unquote(s.trim())).filter((s) => s !== "");
    } else {
      data[key] = unquote(raw);
    }
  }
  return { data, body: lines.slice(close + 1).join("\n") };
}
