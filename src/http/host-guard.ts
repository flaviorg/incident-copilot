// DNS-rebinding and cross-site-write defense (review 2026-11). The API listens on loopback, but a page the operator
// visits can rebind its own domain to 127.0.0.1: the browser then sends that domain in Host. So every request must
// carry a loopback name, HOST or one of ALLOWED_HOSTS in Host, and a write that carries an Origin must come from an
// allowed host too. CLI and curl send no Origin, so they are unaffected.
import type { Config } from "../config.ts";

const LOOPBACK_NAMES = ["localhost", "127.0.0.1", "[::1]"];
const WILDCARD_BINDS = new Set(["0.0.0.0", "::", "[::]"]);

/** Splits `name[:port]` (IPv6 in brackets) into a lowercase name and an optional port. */
function splitHost(value: string): { name: string; port: string | null } {
  const v = value.trim().toLowerCase();
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(v);
  if (!m) return { name: v, port: null };
  return { name: m[1]!, port: m[2] ?? null };
}

export type HostGuard = {
  hostAllowed(host: string | undefined): boolean;
  originAllowed(origin: string): boolean;
};

export function createHostGuard(config: Pick<Config, "host" | "allowedHosts">): HostGuard {
  // Loopback names and HOST match on the name alone: a rebinding attacker controls the name, not the port.
  const anyPort = new Set(LOOPBACK_NAMES);
  const bind = splitHost(config.host).name;
  if (!WILDCARD_BINDS.has(bind)) anyPort.add(bind.includes(":") && !bind.startsWith("[") ? `[${bind}]` : bind);
  // ALLOWED_HOSTS entries match on the name, and on the port when one is given.
  const extra = config.allowedHosts.map(splitHost);

  const allowed = (value: string): boolean => {
    const { name, port } = splitHost(value);
    if (anyPort.has(name)) return true;
    return extra.some((e) => e.name === name && (e.port === null || e.port === port));
  };

  return {
    hostAllowed: (host) => typeof host === "string" && host !== "" && allowed(host),
    originAllowed: (origin) => {
      try {
        return allowed(new URL(origin).host);
      } catch {
        return false;
      }
    },
  };
}
