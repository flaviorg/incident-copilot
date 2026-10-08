// JSON canônico (spec 6.8): base do hash encadeado da auditoria.
// Chaves ordenadas por unidade UTF-16, sem espaços, escape do JSON.stringify, -0 vira 0,
// NaN e Infinity lançam, undefined é omitido em objeto e lança em array.

export function canonicalJson(value: unknown): string {
  return encode(value, "$");
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: número não finito em ${path}`);
      return JSON.stringify(value); // JSON.stringify(-0) === "0"
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: tipo ${typeof value} não suportado em ${path}`);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v, i) => {
      if (v === undefined) throw new TypeError(`canonicalJson: undefined em array em ${path}[${i}]`);
      return encode(v, `${path}[${i}]`);
    }).join(",") + "]";
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new TypeError(`canonicalJson: objeto não simples em ${path}`);
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    parts.push(JSON.stringify(key) + ":" + encode(v, `${path}.${key}`));
  }
  return "{" + parts.join(",") + "}";
}
