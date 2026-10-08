// Carregado com --import no processo de teste e nos filhos (CLI, MCP): nenhum teste usa rede (AC-27).
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
  return "destino desconhecido";
}

globalThis.fetch = (async (input: unknown) => {
  throw new NetworkDisabledInTests(describeTarget(input));
}) as typeof fetch;
