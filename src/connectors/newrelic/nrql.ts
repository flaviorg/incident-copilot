// NRQL from configured templates only (spec 008, decision 11). The model never supplies a query: it names a service
// and a metric, and this module substitutes allowlisted values into an operator-written template. Pure.
import { ConnectorError } from "../shared/errors.ts";

export type NrqlValues = {
  service?: string;
  /** Epoch milliseconds. */
  since?: number;
  /** Epoch milliseconds. */
  until?: number;
  limit?: number;
  level?: "ERROR" | "WARN";
};
export type NrqlPlaceholder = keyof NrqlValues;

/** The characters a service name may use before it goes inside a quoted NRQL string; no quote, backslash or control character. */
export const SERVICE_PATTERN = /^[A-Za-z0-9 ._:/()[\]-]{1,120}$/;
export const MAX_TEMPLATE_LENGTH = 2000;

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const KNOWN: ReadonlySet<string> = new Set<NrqlPlaceholder>(["service", "since", "until", "limit", "level"]);

/**
 * Best-effort defaults, UNVERIFIED against a real account: the event types, the attribute names and whether SINCE
 * accepts epoch milliseconds. Operators override each template in copilot.yaml (docs/connectors/newrelic.md).
 */
export const DEFAULT_NRQL = {
  metrics: {
    error_rate: "SELECT percentage(count(*), WHERE error IS true) FROM Transaction WHERE appName = '{service}' SINCE {since} UNTIL {until} TIMESERIES",
    latency_p99: "SELECT percentile(duration, 99) FROM Transaction WHERE appName = '{service}' SINCE {since} UNTIL {until} TIMESERIES",
    throughput: "SELECT rate(count(*), 1 minute) FROM Transaction WHERE appName = '{service}' SINCE {since} UNTIL {until} TIMESERIES",
  } as Readonly<Record<string, string>>,
  errors: "SELECT count(*) FROM TransactionError WHERE appName = '{service}' FACET error.class, error.message SINCE {since} UNTIL {until} LIMIT {limit}",
  logs: "SELECT timestamp, level, message FROM Log WHERE service.name = '{service}' AND level = '{level}' SINCE {since} UNTIL {until} LIMIT {limit}",
  deploys: "SELECT timestamp, version, user, description FROM Deployment WHERE appName = '{service}' SINCE {since} LIMIT 10",
} as const;

/** True when `index` of `text` sits inside a single-quoted string (counting quotes that are not backslash-escaped). */
function insideSingleQuotes(text: string, index: number): boolean {
  let open = false;
  for (let i = 0; i < index; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "'") open = !open;
  }
  return open;
}

/** Load-time check of a template. Returns a fixed rule text, or null when the template is acceptable. */
export function validateNrqlTemplate(template: string, allowed: readonly NrqlPlaceholder[]): string | null {
  if (template.length > MAX_TEMPLATE_LENGTH) return `template must be at most ${MAX_TEMPLATE_LENGTH} characters`;
  if (!/^\s*(SELECT|FROM)\b/i.test(template)) return "template must start with SELECT or FROM";
  const serviceAt: number[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    const name = m[1]!;
    if (!KNOWN.has(name) || !allowed.includes(name as NrqlPlaceholder)) return `template uses a placeholder that is not supported here; allowed: ${allowed.map((a) => `{${a}}`).join(", ")}`;
    if (name === "service") serviceAt.push(m.index);
  }
  if (serviceAt.length === 0) return "template must contain {service}";
  if (serviceAt.some((i) => !insideSingleQuotes(template, i))) return "{service} must be inside single quotes";
  return null;
}

const unsafe = () => new ConnectorError("unsafe_input");

function integer(v: unknown, min: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) throw unsafe();
  return v;
}

/**
 * Substitutes every {placeholder} in one pass (a substituted value is never scanned again). Throws
 * ConnectorError("unsafe_input") for a service outside SERVICE_PATTERN, a number that is not a safe integer, a level
 * other than ERROR or WARN, a placeholder without a value, or a placeholder this module does not know.
 */
export function renderNrql(template: string, values: NrqlValues): string {
  return template.replace(PLACEHOLDER, (_whole, name: string) => {
    switch (name) {
      case "service": {
        const s = values.service;
        if (typeof s !== "string" || !SERVICE_PATTERN.test(s)) throw unsafe();
        return s;
      }
      case "since": return String(integer(values.since, 0));
      case "until": return String(integer(values.until, 0));
      case "limit": return String(integer(values.limit, 1));
      case "level": {
        if (values.level !== "ERROR" && values.level !== "WARN") throw unsafe();
        return values.level;
      }
      default: throw unsafe();
    }
  });
}
