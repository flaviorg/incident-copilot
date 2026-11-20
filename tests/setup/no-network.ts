// Loaded with --import in the test process and the children (CLI, MCP): no test uses the network (AC-27).
class NetworkDisabledInTests extends Error {
  constructor(target: string) {
    super(`rede desativada nos testes: ${target}`);
    this.name = "NetworkDisabledInTests";
  }
}

function describeTarget(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && "url" in input) return String((input as { url: unknown }).url);
  return "unknown destination";
}

globalThis.fetch = (async (input: unknown) => {
  throw new NetworkDisabledInTests(describeTarget(input));
}) as typeof fetch;
