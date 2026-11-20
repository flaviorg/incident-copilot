// Service names across providers (spec 008): each connector may call the same service by another name. Pure.

/** Canonical services with, per connector id, the names that connector uses. */
export type ServiceMap = { name: string; aliases: Record<string, string[]> }[];

const norm = (s: string) => s.trim().toLowerCase();

/** Alias of this connector first, then a canonical name (both case-insensitive and trimmed); otherwise the raw value. */
export function canonicalService(map: ServiceMap, connectorId: string, raw: string): string;
export function canonicalService(map: ServiceMap, connectorId: string, raw: string | null): string | null;
export function canonicalService(map: ServiceMap, connectorId: string, raw: string | null): string | null {
  if (raw === null) return null;
  const wanted = norm(raw);
  for (const s of map) {
    const aliases = Object.hasOwn(s.aliases, connectorId) ? s.aliases[connectorId]! : [];
    if (aliases.some((a) => norm(a) === wanted)) return s.name;
  }
  return map.find((s) => norm(s.name) === wanted)?.name ?? raw;
}

/** The name this connector uses for a canonical service: its first alias, else the canonical name. */
export function aliasFor(map: ServiceMap, connectorId: string, canonical: string): string {
  const s = map.find((x) => x.name === canonical);
  const aliases = s && Object.hasOwn(s.aliases, connectorId) ? s.aliases[connectorId]! : [];
  return aliases[0] ?? canonical;
}

export function isKnownService(map: ServiceMap, name: string): boolean {
  return map.some((s) => s.name === name);
}
