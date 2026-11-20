// Generic MCP data source connector config (docs/connectors/mcp.md). The operator names every tool the model may call;
// descriptions are operator text, header values and stdio env values are secrets or interpolated strings.
import * as z from "zod";
import type { ConfigHelpers } from "../shared/config-helpers.ts";
import { MCP_MAX_ARGUMENTS, placeholdersOf } from "./arguments.ts";

export const MCP_DEFAULT_TIMEOUT_MS = 15_000;
export const MCP_DEFAULT_MAX_RESULT_CHARS = 4000;
export const MCP_MAX_TOOLS = 20;
export const MCP_MAX_ARGS = 20;

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// An absolute path (no NUL, no spaces) or a bare command name looked up on PATH. Relative paths are refused so the
// command never depends on the working directory.
const COMMAND = /^(?:\/[^\0\s]*|[A-Za-z0-9][A-Za-z0-9._+-]*)$/;
// Headers the transport owns, or that change how the request is framed.
const RESERVED_HEADERS = new Set([
  "accept", "connection", "content-length", "content-type", "host", "mcp-protocol-version", "mcp-session-id", "transfer-encoding", "last-event-id",
]);
const ARGUMENT_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const hasControl = (s: string) => /[\u0000-\u001f\u007f]/.test(s);

export function mcpConfigSchema(h: ConfigHelpers) {
  const headerName = z.string().regex(HEADER_NAME, "must be 1 to 64 letters, digits or hyphens");
  return z
    .strictObject({
      transport: z.enum(["http", "stdio"]),
      /** http only: the Streamable HTTP endpoint. */
      url: h.url({ allowLoopbackHttp: true }).optional(),
      /** http only: non-secret headers (for example include-tags). */
      headers: z.array(z.strictObject({ name: headerName, value: h.text({ max: 500 }) })).max(10).optional(),
      /** http only: secret headers (for example api-key); every value is a whole ${VAR} reference. */
      secretHeaders: z.record(headerName, h.secret({ min: 8 })).optional(),
      /** stdio only: an absolute path or a bare command name. */
      command: z.string().max(500).regex(COMMAND, "must be an absolute path or a bare command name").optional(),
      args: z.array(h.text({ max: 500 })).max(MCP_MAX_ARGS).optional(),
      /** stdio only: environment for the child process; every value is a whole ${VAR} reference. */
      env: z.record(z.string().regex(ENV_NAME, "must be a valid environment variable name"), h.secret({ min: 1 })).optional(),
      /** The allowlist: the only tools the model can see or call. */
      tools: z
        .array(
          z.strictObject({
            name: z.string().min(1).max(128),
            /** Operator-written text; when given, the server's own description is never shown to the model. */
            description: h.text({ max: 500 }).optional(),
            maxResultChars: z.number().int().min(200).max(8000).default(MCP_DEFAULT_MAX_RESULT_CHARS),
            /**
             * The arguments sent to the server, written by the operator (decision 11: the model never writes a query).
             * String values may use {service} and {window}; those are the only things the model chooses, and each
             * value passes an allowlist. Without this field the tool takes no model arguments at all.
             */
            arguments: z.record(z.string().regex(ARGUMENT_NAME, "must be an identifier of at most 64 characters"), z.union([h.text({ max: 500 }), z.number(), z.boolean()])).optional(),
          }),
        )
        .min(1)
        .max(MCP_MAX_TOOLS),
      timeoutMs: z.number().int().min(1000).max(60_000).default(MCP_DEFAULT_TIMEOUT_MS),
    })
    .superRefine((c, ctx) => {
      const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
      if (c.transport === "http") {
        if (c.url === undefined) issue(["url"], "is required when transport is http");
        for (const k of ["command", "args", "env"] as const) if (c[k] !== undefined) issue([k], "is only valid when transport is stdio");
      } else {
        if (c.command === undefined) issue(["command"], "is required when transport is stdio");
        for (const k of ["url", "headers", "secretHeaders"] as const) if (c[k] !== undefined) issue([k], "is only valid when transport is http");
      }
      const seenTools = new Set<string>();
      c.tools.forEach((t, i) => {
        if (seenTools.has(t.name)) issue(["tools", i, "name"], "duplicate tool name");
        seenTools.add(t.name);
        if (t.arguments !== undefined) {
          if (Object.keys(t.arguments).length > MCP_MAX_ARGUMENTS) issue(["tools", i, "arguments"], `at most ${MCP_MAX_ARGUMENTS} arguments`);
          if (placeholdersOf(t.arguments).unknown !== null) issue(["tools", i, "arguments"], "only the placeholders {service} and {window} are supported");
        }
      });
      const seenHeaders = new Set<string>();
      const header = (name: string, path: (string | number)[]) => {
        const key = name.toLowerCase();
        if (RESERVED_HEADERS.has(key)) issue(path, "this header is set by the MCP transport");
        else if (seenHeaders.has(key)) issue(path, "duplicate header name");
        seenHeaders.add(key);
      };
      c.headers?.forEach((x, i) => {
        header(x.name, ["headers", i, "name"]);
        if (hasControl(x.value)) issue(["headers", i, "value"], "must not contain control characters");
      });
      for (const name of Object.keys(c.secretHeaders ?? {})) header(name, ["secretHeaders", name]);
    });
}

export type McpConfig = z.infer<ReturnType<typeof mcpConfigSchema>>;
