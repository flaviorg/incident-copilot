// Resultado das tools MCP (spec 5.4 e 6.1): content com texto curto e structuredContent validado, ambos redigidos;
// erro vira { isError: true, content: [{ type: "text", text: motivo curto }] }, sem stack, SQL ou mensagem bruta.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type * as z from "zod";
import type { Container } from "../app/container.ts";
import {
  ConflictError, FixturePromptDriftError, LlmUnavailableError, NotFoundError, RunTimeoutError, UnprocessableError, UnscriptedLlmCallError,
  ValidationError,
} from "../domain/errors.ts";
import { redactSecrets } from "../infra/redact.ts";

/** Teto do texto de erro devolvido ao cliente MCP. */
const MCP_ERROR_MAX_CHARS = 180;

const clip = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max - 1) + "…");

export function toolOk<T extends Record<string, unknown>>(c: Container, schema: z.ZodType<T>, value: T, text: string): CallToolResult {
  const structured = redactSecrets(schema.parse(value), c.secrets);
  return { content: [{ type: "text", text: redactSecrets(clip(text, 1000), c.secrets) }], structuredContent: structured };
}

/** Motivo curto em pt-BR por classe de erro (tabela do spec 6.1). */
function shortReason(e: unknown): { text: string; unexpected: boolean } {
  if (e instanceof ValidationError) {
    const fields = e.issues.map((i) => i.path).join(", ");
    return { text: fields ? `entrada inválida: ${fields}` : "entrada inválida", unexpected: false };
  }
  if (e instanceof NotFoundError) return { text: e.code === "scenario_not_found" ? "cenário não encontrado" : e.message, unexpected: false };
  if (e instanceof ConflictError) {
    if (e.code === "version_conflict") return { text: "o incidente mudou; tente de novo", unexpected: false };
    if (e.code === "incident_not_accepting") return { text: "o incidente não aceita propostas neste estado", unexpected: false };
    return { text: e.message, unexpected: false };
  }
  if (e instanceof UnprocessableError || e instanceof LlmUnavailableError || e instanceof RunTimeoutError) return { text: e.message, unexpected: false };
  if (e instanceof UnscriptedLlmCallError || e instanceof FixturePromptDriftError) return { text: "erro de fixture do provedor fake", unexpected: true };
  return { text: "erro interno", unexpected: true };
}

export function toolError(c: Container, e: unknown, tool: string): CallToolResult {
  const { text, unexpected } = shortReason(e);
  if (unexpected) {
    const err = e as { name?: unknown; message?: unknown };
    c.logger.error("erro inesperado numa tool MCP", {
      tool, error: typeof err?.name === "string" ? err.name : "Error", detail: typeof err?.message === "string" ? clip(err.message, 500) : null,
    });
  } else {
    c.logger.info("tool MCP recusou o pedido", { tool, reason: clip(text, MCP_ERROR_MAX_CHARS) });
  }
  return { isError: true, content: [{ type: "text", text: redactSecrets(clip(text, MCP_ERROR_MAX_CHARS), c.secrets) }] };
}
