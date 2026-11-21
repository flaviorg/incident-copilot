// Provider severity to incident severity (spec 008). Pure; the lookup ignores case and surrounding spaces.
import type { Severity } from "../../contracts/index.ts";

export function mapSeverity(value: string | null | undefined, map: Readonly<Record<string, Severity>>, fallback: Severity): Severity {
  if (typeof value !== "string") return fallback;
  const wanted = value.trim().toLowerCase();
  for (const [k, sev] of Object.entries(map)) if (k.trim().toLowerCase() === wanted) return sev;
  return fallback;
}
