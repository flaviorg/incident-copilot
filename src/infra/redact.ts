// Defense in depth (spec 6.6): replaces literal occurrences of the secrets with [REDACTED] in any text leaving the process.
import type { Config } from "../config.ts";

export const REDACTED = "[REDACTED]";
const MIN_SECRET_LENGTH = 8;

/** Known secrets from the config, only the defined ones with 8 characters or more. */
export function collectSecrets(c: Pick<Config, "approvalToken" | "openrouterApiKey"> & Partial<Pick<Config, "apiToken">>): string[] {
  return [c.approvalToken, c.openrouterApiKey, c.apiToken ?? null].filter((s): s is string => typeof s === "string" && s.length >= MIN_SECRET_LENGTH);
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

/**
 * Each secret plus its JSON-escaped form when that differs (a token with `"` or `\\` appears escaped in a serialized
 * body, so the literal match alone would miss it).
 */
function withEscapedForms(secrets: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of secrets) {
    if (s.length < MIN_SECRET_LENGTH) continue;
    out.add(s);
    const escaped = JSON.stringify(s).slice(1, -1);
    if (escaped !== s) out.add(escaped);
  }
  return [...out];
}

/** Recursive over strings, arrays and plain objects; `Error` becomes a redacted `{ name, message }`. Does not mutate the input. */
export function redactSecrets<T>(value: T, secrets: readonly string[]): T {
  // Longest first, so a secret that contains another is not left half-redacted.
  const ordered = withEscapedForms(secrets).sort((a, b) => b.length - a.length);
  return walk(value, ordered) as T;
}

/** Redacts first, then clips to `max` characters (with "…"), so a secret straddling the cut can never leak a prefix. */
export function redactThenClip(text: string, max: number, secrets: readonly string[]): string {
  const redacted = redactSecrets(text, secrets);
  return redacted.length <= max ? redacted : redacted.slice(0, max - 1) + "…";
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
