// Defensive readers for provider payloads (spec 008, decision 11). Never throw on unexpected shapes.
import { canonicalJson } from "../../domain/canonical-json.ts";
import { sanitizeText } from "../../domain/ingest/sanitize.ts";
import { sha256Hex } from "../../infra/crypto.ts";

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function fromEpoch(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e11 ? n * 1000 : n; // below 1e11 it is epoch seconds (until year 5138)
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * ISO-8601 with any number of fraction digits (RFC 3339 with nanoseconds included), epoch milliseconds, epoch seconds
 * (< 1e11) or a numeric string; normalized with toISOString. The Go zero time (year 0001) and anything else give null.
 */
export function toIsoOrNull(v: unknown): string | null {
  if (typeof v === "number") return fromEpoch(v);
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return fromEpoch(Number(s));
  const m = ISO.exec(s);
  if (!m) return null;
  if (Number(m[1]) < 1970) return null;
  const fraction = m[7] ? m[7].slice(0, 4).padEnd(4, "0") : "";
  const zone = m[8]!.toUpperCase() === "Z" ? "Z" : m[8]!.length === 5 ? `${m[8]!.slice(0, 3)}:${m[8]!.slice(3)}` : m[8]!;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${fraction}${zone}`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** An http(s) URL of at most 2000 characters, else null. */
export function httpUrlOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s === "" || s.length > 2000) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

/** Dot path with numeric indexes ("alerts.0.labels.service"); own properties only, never __proto__, constructor or prototype. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (seg === "" || FORBIDDEN_SEGMENTS.has(seg)) return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return undefined;
      cur = cur[Number(seg)];
    } else if (cur !== null && typeof cur === "object") {
      if (!Object.hasOwn(cur, seg)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** First 16 hex characters of the SHA-256 of the canonical JSON (a stable fingerprint for unordered labels). */
export function stableHash(value: unknown): string {
  return sha256Hex(canonicalJson(value)).slice(0, 16);
}

/** A non-empty sanitized string (numbers are accepted and stringified), clipped to `max`; otherwise null. */
export function asString(v: unknown, max: number): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const s = sanitizeText(v, max);
  return s === "" ? null : s;
}

/** A plain object (not an array, not null), else null. */
export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
