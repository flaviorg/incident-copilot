// Spec 009, decision 7: the sandbox preload. Self-contained (only node:* imports), copied into <attempt>/kit/ and
// loaded with --import after any test-only import, so it wins. Best effort only: Node 24.21 has no --allow-net, so
// network isolation is the OS's job (unshare in `isolated` mode). It replaces fetch and WebSocket, blocks the network
// and child-process built-ins for import and require through module.registerHooks, patches process.getBuiltinModule,
// and stops later code from registering hooks of its own. The permission model denies child processes on its own.
import * as nodeModule from "node:module";

const BLOCKED: ReadonlySet<string> = new Set([
  "net", "tls", "dgram", "dns", "dns/promises", "http", "https", "http2", "child_process",
  "_http_agent", "_http_client", "_http_common", "_http_incoming", "_http_outgoing", "_http_server", "_tls_common", "_tls_wrap",
]);

class SandboxNetworkDenied extends Error {
  readonly code = "ERR_ACCESS_DENIED";
  constructor(what: string) {
    super(`blocked in the code-fix sandbox: ${what}`);
    this.name = "SandboxNetworkDenied";
  }
}

function builtinName(specifier: unknown): string | null {
  if (typeof specifier !== "string") return null;
  return specifier.startsWith("node:") ? specifier.slice(5) : specifier;
}

function isBlocked(specifier: unknown): boolean {
  const name = builtinName(specifier);
  return name !== null && BLOCKED.has(name);
}

nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isBlocked(specifier)) throw new SandboxNetworkDenied(`module ${specifier}`);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("node:") && isBlocked(url)) throw new SandboxNetworkDenied(`module ${url}`);
    return nextLoad(url, context);
  },
});

function lock(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: false, configurable: false, enumerable: true });
}

const originalGetBuiltinModule = process.getBuiltinModule.bind(process);
lock(process, "getBuiltinModule", function getBuiltinModule(id: string) {
  if (isBlocked(id)) throw new SandboxNetworkDenied(`module ${id}`);
  return originalGetBuiltinModule(id);
});

lock(globalThis, "fetch", async function fetch(input: unknown): Promise<never> {
  void input;
  throw new SandboxNetworkDenied("fetch");
});

lock(globalThis, "WebSocket", class WebSocket {
  constructor() {
    throw new SandboxNetworkDenied("WebSocket");
  }
});

if ("EventSource" in globalThis) {
  lock(globalThis, "EventSource", class EventSource {
    constructor() {
      throw new SandboxNetworkDenied("EventSource");
    }
  });
}

// Later hooks run first and could skip ours; refuse new ones (module.register needs a worker, which is denied anyway).
const moduleExports = (nodeModule as unknown as { default?: Record<string, unknown> }).default;
if (moduleExports) {
  const refuse = () => {
    throw new SandboxNetworkDenied("module hooks");
  };
  lock(moduleExports, "registerHooks", refuse);
  lock(moduleExports, "register", refuse);
  nodeModule.syncBuiltinESMExports();
}
