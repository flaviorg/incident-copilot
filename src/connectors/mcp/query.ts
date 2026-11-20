// The `external` query capability of the MCP connector (spec 008, AC-50 and AC-58): the operator's allowlist decides
// what the model sees, the server's own annotations can only remove a tool, the model never writes an argument (it only
// fills the operator's {service} and {window} placeholders), and every server string is untrusted text that is sanitized
// and clipped before it leaves this file.
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ExternalResult, ExternalToolInfo } from "../../contracts/index.ts";
import { sanitizeText } from "../../domain/ingest/sanitize.ts";
import type { Logger } from "../../infra/logger.ts";
import { ConnectorError } from "../shared/errors.ts";
import type { QueryCapability, QueryIO } from "../types.ts";
import type { McpConnection } from "./client.ts";
import type { McpConfig } from "./config.ts";
import { modelInputSchema, renderArguments } from "./arguments.ts";

export const TOOL_DESCRIPTION_MAX = 1000;
const EMPTY_RESULT = "(no text content)";

type Exposed = { info: ExternalToolInfo; maxResultChars: number };

/** A tool the server marks destructive or not read-only is refused whatever the operator allowlisted. */
export function isRefusedByAnnotations(t: Pick<Tool, "annotations">): boolean {
  return t.annotations?.destructiveHint === true || t.annotations?.readOnlyHint === false;
}

/** Text items joined with newlines, the others counted; sanitized and clipped to `max` including the count note. */
export function formatToolResult(result: CallToolResult, max: number): ExternalResult {
  const items = Array.isArray(result.content) ? result.content : [];
  const texts: string[] = [];
  let other = 0;
  for (const item of items) {
    if (item && item.type === "text" && typeof item.text === "string") texts.push(item.text);
    else other++;
  }
  const note = other > 0 ? `(${other} non-text items omitted)` : "";
  // Cut before sanitizing so a hostile multi-megabyte answer costs nothing; sanitizing only removes characters.
  const joined = texts.join("\n").slice(0, max * 4);
  const body = sanitizeText(joined, note === "" ? max : Math.max(0, max - note.length - 1));
  const text = body === "" ? (note === "" ? EMPTY_RESULT : note) : note === "" ? body : `${body}\n${note}`;
  return { ok: result.isError !== true, text };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};

export function createMcpQuery(o: { config: McpConfig; connection: McpConnection; logger: Logger }): { query: QueryCapability; resetTools(): void } {
  const allow = new Map(o.config.tools.map((t) => [t.name, t]));
  let exposed: Promise<Map<string, Exposed>> | null = null;

  const list = async (io: QueryIO): Promise<Map<string, Exposed>> => {
    const server = new Map((await o.connection.listTools(io)).map((t) => [t.name, t]));
    const out = new Map<string, Exposed>();
    for (const [name, cfg] of allow) {
      const t = server.get(name);
      if (!t) {
        o.logger.warn("mcp tool is allowlisted but the server does not list it", { event: "mcp_tool_missing", tool: name });
        continue;
      }
      if (isRefusedByAnnotations(t)) {
        o.logger.warn("mcp tool refused: the server marks it destructive or not read-only", { event: "mcp_tool_refused", tool: name });
        continue;
      }
      out.set(name, {
        maxResultChars: cfg.maxResultChars,
        info: {
          name,
          description: sanitizeText(cfg.description ?? t.description ?? "", TOOL_DESCRIPTION_MAX),
          inputSchema: modelInputSchema(cfg.arguments),
        },
      });
    }
    return out;
  };

  const exposedTools = (io: QueryIO): Promise<Map<string, Exposed>> => {
    if (!exposed) {
      const p = list(io);
      exposed = p;
      p.catch(() => {
        if (exposed === p) exposed = null; // a failed listing is retried on the next call
      });
    }
    return exposed;
  };

  return {
    resetTools: () => {
      exposed = null;
    },
    query: {
      external: {
        async tools(io) {
          return [...(await exposedTools(io)).values()].map((e) => e.info);
        },
        async call(tool, args, io) {
          if (!allow.has(tool) || !isPlainObject(args)) throw new ConnectorError("unsafe_input");
          // The model only fills the template's placeholders; the server sees the operator's arguments, never a model
          // string. Checked before any connection is opened.
          const rendered = renderArguments(allow.get(tool)!.arguments, args);
          const e = (await exposedTools(io)).get(tool);
          if (!e) throw new ConnectorError("unsafe_input");
          return formatToolResult(await o.connection.callTool(tool, rendered, io), e.maxResultChars);
        },
      },
    },
  };
}
