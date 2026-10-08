// Defesa em profundidade (spec 6.6): troca ocorrências literais dos segredos por [REDACTED] em todo texto que sai do processo.
import type { Config } from "../config.ts";

export const REDACTED = "[REDACTED]";
const MIN_SECRET_LENGTH = 8;

/** Segredos conhecidos da configuração, só os definidos e com 8 caracteres ou mais. */
export function collectSecrets(c: Pick<Config, "approvalToken" | "openrouterApiKey">): string[] {
  return [c.approvalToken, c.openrouterApiKey].filter((s): s is string => typeof s === "string" && s.length >= MIN_SECRET_LENGTH);
}

function redactString(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH && out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Recursivo sobre strings, arrays e objetos simples; `Error` vira `{ name, message }` redigido. Não altera a entrada. */
export function redactSecrets<T>(value: T, secrets: readonly string[]): T {
  // O mais longo primeiro, para um segredo que contém outro não sobrar pela metade.
  const ordered = [...secrets].filter((s) => s.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
  return walk(value, ordered) as T;
}

function walk(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return secrets.length === 0 ? value : redactString(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return { name: value.name, message: redactString(value.message, secrets) };
  if (Array.isArray(value)) return value.map((v) => walk(v, secrets));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = walk(v, secrets);
  return out;
}
