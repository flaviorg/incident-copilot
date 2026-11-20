// Reads and validates the environment with Zod and fails early (spec 5.6). It does not read `.env`: Node does that with --env-file-if-exists.
import * as z from "zod";

export type LlmProviderName = "fake" | "openrouter";

export type Config = {
  llmProvider: LlmProviderName;
  openrouterApiKey: string | null;
  openrouterModel: string | null;
  openrouterModelFallback: string | null;
  llmBaseUrl: string;
  llmTimeoutMs: number;
  runTimeoutMs: number;
  dbPath: string;
  host: string;
  port: number;
  /** Extra names accepted in the Host header (lowercase, `name` or `name:port`), besides the loopback names and HOST. */
  allowedHosts: string[];
  /** Incident runs started by POST /incidents allowed at the same time. */
  maxConcurrentRuns: number;
  approvalToken: string | null;
  /** Bearer token for every HTTP route but /health. Required when HOST is not loopback (assertApiExposureSafe). */
  apiToken: string | null;
  approvalTtlMin: number;
  actionRateLimitPerMin: number;
  actionRepeatWindowMin: number;
  circuitFailureThreshold: number;
  circuitCooldownSec: number;
  clock: "system" | "simulated";
  logLevel: "debug" | "info" | "warn" | "error";
};

/** Configuration error. The message lists the offending variables and the rule, never the values. */
export class ConfigError extends Error {
  readonly variables: string[];
  constructor(problems: { variable: string; rule: string }[]) {
    super(`invalid configuration: ${problems.map((p) => `${p.variable} (${p.rule})`).join("; ")}`);
    this.name = "ConfigError";
    this.variables = problems.map((p) => p.variable);
  }
}

const APPROVAL_TOKEN_MIN_LENGTH = 16;

// Readable rule per variable. The error message uses only this, never Zod's text (which could quote the input).
const RULES: Record<string, string> = {
  LLM_PROVIDER: "use fake or openrouter",
  LLM_BASE_URL: "must be a URL",
  LLM_TIMEOUT_MS: "positive integer",
  RUN_TIMEOUT_MS: "positive integer",
  PORT: "positive integer",
  ALLOWED_HOSTS: "comma-separated host names, optionally with :port",
  MAX_CONCURRENT_RUNS: "positive integer",
  APPROVAL_TOKEN: `at least ${APPROVAL_TOKEN_MIN_LENGTH} characters when set`,
  API_TOKEN: `at least ${APPROVAL_TOKEN_MIN_LENGTH} characters when set`,
  APPROVAL_TTL_MIN: "positive integer",
  ACTION_RATE_LIMIT_PER_MIN: "positive integer",
  ACTION_REPEAT_WINDOW_MIN: "positive integer",
  CIRCUIT_FAILURE_THRESHOLD: "positive integer",
  CIRCUIT_COOLDOWN_SEC: "positive integer",
  CLOCK: "use system or simulated",
  LOG_LEVEL: "use debug, info, warn or error",
};

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const EnvSchema = z.object({
  LLM_PROVIDER: z.enum(["fake", "openrouter"]).optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().optional(),
  OPENROUTER_MODEL_FALLBACK: z.string().optional(),
  LLM_BASE_URL: z.url().default("https://openrouter.ai/api/v1"),
  LLM_TIMEOUT_MS: positiveInt(30000),
  RUN_TIMEOUT_MS: positiveInt(180000),
  DB_PATH: z.string().default("./data/incident-copilot.db"),
  HOST: z.string().default("127.0.0.1"),
  PORT: positiveInt(3000),
  ALLOWED_HOSTS: z.string().regex(/^[A-Za-z0-9.\-:\[\], ]+$/).optional(),
  MAX_CONCURRENT_RUNS: positiveInt(2),
  APPROVAL_TOKEN: z.string().min(APPROVAL_TOKEN_MIN_LENGTH).optional(),
  API_TOKEN: z.string().min(APPROVAL_TOKEN_MIN_LENGTH).optional(),
  APPROVAL_TTL_MIN: positiveInt(30),
  ACTION_RATE_LIMIT_PER_MIN: positiveInt(5),
  ACTION_REPEAT_WINDOW_MIN: positiveInt(10),
  CIRCUIT_FAILURE_THRESHOLD: positiveInt(3),
  CIRCUIT_COOLDOWN_SEC: positiveInt(300),
  CLOCK: z.enum(["system", "simulated"]).default("system"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export function loadConfig(env: Record<string, string | undefined>, opts: { forceFake?: boolean } = {}): Config {
  // Empty strings (or whitespace only) count as unset.
  const cleaned: Record<string, string> = {};
  for (const key of Object.keys(EnvSchema.shape)) {
    const value = env[key];
    if (value !== undefined && value.trim() !== "") cleaned[key] = value.trim();
  }

  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const seen = new Set<string>();
    const problems: { variable: string; rule: string }[] = [];
    for (const issue of parsed.error.issues) {
      const variable = String(issue.path[0] ?? "ambiente");
      if (seen.has(variable)) continue;
      seen.add(variable);
      problems.push({ variable, rule: RULES[variable] ?? "invalid value" });
    }
    throw new ConfigError(problems);
  }
  const e = parsed.data;

  // Autodetection (spec 5.6): without LLM_PROVIDER, the key turns on openrouter; LLM_PROVIDER=fake and forceFake win over the key.
  let llmProvider: LlmProviderName = e.LLM_PROVIDER ?? (e.OPENROUTER_API_KEY ? "openrouter" : "fake");
  if (opts.forceFake) llmProvider = "fake";

  // One token must not open both doors: the API token reaches every route, the approval token decides tier 3.
  if (e.API_TOKEN && e.API_TOKEN === e.APPROVAL_TOKEN) {
    throw new ConfigError([{ variable: "API_TOKEN", rule: "must differ from APPROVAL_TOKEN" }]);
  }

  if (llmProvider === "openrouter") {
    const problems: { variable: string; rule: string }[] = [];
    if (!e.OPENROUTER_API_KEY) problems.push({ variable: "OPENROUTER_API_KEY", rule: "required with the openrouter provider" });
    if (!e.OPENROUTER_MODEL) problems.push({ variable: "OPENROUTER_MODEL", rule: "required with the openrouter provider" });
    if (problems.length > 0) throw new ConfigError(problems);
  }

  return {
    llmProvider,
    openrouterApiKey: e.OPENROUTER_API_KEY ?? null,
    openrouterModel: e.OPENROUTER_MODEL ?? null,
    openrouterModelFallback: e.OPENROUTER_MODEL_FALLBACK ?? null,
    llmBaseUrl: e.LLM_BASE_URL,
    llmTimeoutMs: e.LLM_TIMEOUT_MS,
    runTimeoutMs: e.RUN_TIMEOUT_MS,
    dbPath: e.DB_PATH,
    host: e.HOST,
    port: e.PORT,
    allowedHosts: (e.ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter((h) => h !== ""),
    maxConcurrentRuns: e.MAX_CONCURRENT_RUNS,
    approvalToken: e.APPROVAL_TOKEN ?? null,
    apiToken: e.API_TOKEN ?? null,
    approvalTtlMin: e.APPROVAL_TTL_MIN,
    actionRateLimitPerMin: e.ACTION_RATE_LIMIT_PER_MIN,
    actionRepeatWindowMin: e.ACTION_REPEAT_WINDOW_MIN,
    circuitFailureThreshold: e.CIRCUIT_FAILURE_THRESHOLD,
    circuitCooldownSec: e.CIRCUIT_COOLDOWN_SEC,
    clock: e.CLOCK,
    logLevel: e.LOG_LEVEL,
  };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** True for the names that only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/**
 * Checked by the API entry point only (the MCP server and the CLI do not listen): binding HOST beyond loopback
 * without API_TOKEN would expose every incident, trace and audit, and let anyone start runs, so startup fails.
 */
export function assertApiExposureSafe(c: Pick<Config, "host" | "apiToken">): void {
  if (!isLoopbackHost(c.host) && c.apiToken === null) {
    throw new ConfigError([{ variable: "API_TOKEN", rule: "required when HOST is not a loopback address" }]);
  }
}
