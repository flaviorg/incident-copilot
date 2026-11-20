// Arguments of an allowlisted MCP tool (spec 008, decision 11): the operator writes them, the model only fills the
// {service} and {window} placeholders, and each value passes a strict allowlist before it is substituted. A key the
// template does not use is refused, so the model can never supply a query string or any other free-form argument. Pure.
import { MetricWindowSchema } from "../../contracts/index.ts";
import { ConnectorError } from "../shared/errors.ts";

export type McpArgumentValue = string | number | boolean;
export type McpArguments = Readonly<Record<string, McpArgumentValue>>;
export type McpPlaceholder = "service" | "window";

export const MCP_MAX_ARGUMENTS = 10;
export const MCP_SERVICE_MAX = 120;
/** Same characters as the NRQL service allowlist: no quote, backslash, control character or newline. */
export const MCP_SERVICE_PATTERN = /^[A-Za-z0-9 ._:/()[\]-]{1,120}$/;

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const KNOWN: ReadonlySet<string> = new Set<McpPlaceholder>(["service", "window"]);
const WINDOW_TEXT: Readonly<Record<string, string>> = { "15m": "15 minutes", "30m": "30 minutes", "60m": "60 minutes", "24h": "24 hours", "7d": "7 days" };
const WINDOWS = MetricWindowSchema.options as readonly string[];

/** Names of the placeholders a template uses, or the first one that is not supported. */
export function placeholdersOf(args: McpArguments | undefined): { used: McpPlaceholder[]; unknown: string | null } {
  const used = new Set<McpPlaceholder>();
  for (const v of Object.values(args ?? {})) {
    if (typeof v !== "string") continue;
    for (const m of v.matchAll(PLACEHOLDER)) {
      if (!KNOWN.has(m[1]!)) return { used: [], unknown: m[1]! };
      used.add(m[1] as McpPlaceholder);
    }
  }
  return { used: [...used].sort(), unknown: null };
}

/** The JSON schema the model sees: only the placeholders, nothing from the server. */
export function modelInputSchema(args: McpArguments | undefined): unknown {
  const { used } = placeholdersOf(args);
  const properties: Record<string, unknown> = {};
  if (used.includes("service")) properties.service = { type: "string", maxLength: MCP_SERVICE_MAX };
  if (used.includes("window")) properties.window = { enum: [...WINDOWS] };
  return { type: "object", properties, ...(used.length > 0 ? { required: used } : {}), additionalProperties: false };
}

const unsafe = () => new ConnectorError("unsafe_input");

/** Validates the model's values (exactly the placeholders the template uses) and renders the arguments for the server. */
export function renderArguments(template: McpArguments | undefined, given: Record<string, unknown>): Record<string, McpArgumentValue> {
  const { used } = placeholdersOf(template);
  const keys = Object.keys(given);
  if (keys.length !== used.length || keys.some((k) => !used.includes(k as McpPlaceholder))) throw unsafe();
  const values: Record<McpPlaceholder, string> = { service: "", window: "" };
  for (const k of used) {
    const v = given[k];
    if (typeof v !== "string") throw unsafe();
    if (k === "service") {
      if (!MCP_SERVICE_PATTERN.test(v)) throw unsafe();
      values.service = v;
    } else {
      const text = WINDOW_TEXT[v];
      if (!WINDOWS.includes(v) || text === undefined) throw unsafe();
      values.window = text;
    }
  }
  const out: Record<string, McpArgumentValue> = {};
  for (const [name, v] of Object.entries(template ?? {})) {
    out[name] = typeof v === "string" ? v.replace(PLACEHOLDER, (_w, p: string) => values[p as McpPlaceholder]) : v;
  }
  return out;
}
