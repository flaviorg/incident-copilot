// Lê e valida o ambiente com Zod e falha cedo (spec 5.6). Não lê `.env`: o Node faz isso com --env-file-if-exists.
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
  approvalToken: string | null;
  approvalTtlMin: number;
  actionRateLimitPerMin: number;
  actionRepeatWindowMin: number;
  circuitFailureThreshold: number;
  circuitCooldownSec: number;
  clock: "system" | "simulated";
  logLevel: "debug" | "info" | "warn" | "error";
};

/** Erro de configuração. A mensagem lista as variáveis com problema e a regra, nunca os valores. */
export class ConfigError extends Error {
  readonly variables: string[];
  constructor(problems: { variable: string; rule: string }[]) {
    super(`invalid configuration: ${problems.map((p) => `${p.variable} (${p.rule})`).join("; ")}`);
    this.name = "ConfigError";
    this.variables = problems.map((p) => p.variable);
  }
}

const APPROVAL_TOKEN_MIN_LENGTH = 16;

// Regra legível por variável. A mensagem de erro usa só isto, nunca o texto do Zod (que poderia citar a entrada).
const RULES: Record<string, string> = {
  LLM_PROVIDER: "use fake or openrouter",
  LLM_BASE_URL: "must be a URL",
  LLM_TIMEOUT_MS: "positive integer",
  RUN_TIMEOUT_MS: "positive integer",
  PORT: "positive integer",
  APPROVAL_TOKEN: `at least ${APPROVAL_TOKEN_MIN_LENGTH} characters when set`,
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
  APPROVAL_TOKEN: z.string().min(APPROVAL_TOKEN_MIN_LENGTH).optional(),
  APPROVAL_TTL_MIN: positiveInt(30),
  ACTION_RATE_LIMIT_PER_MIN: positiveInt(5),
  ACTION_REPEAT_WINDOW_MIN: positiveInt(10),
  CIRCUIT_FAILURE_THRESHOLD: positiveInt(3),
  CIRCUIT_COOLDOWN_SEC: positiveInt(300),
  CLOCK: z.enum(["system", "simulated"]).default("system"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export function loadConfig(env: Record<string, string | undefined>, opts: { forceFake?: boolean } = {}): Config {
  // Strings vazias (ou só espaços) contam como ausentes.
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

  // Autodetecção (spec 5.6): sem LLM_PROVIDER, a chave liga o openrouter; LLM_PROVIDER=fake e forceFake vencem a chave.
  let llmProvider: LlmProviderName = e.LLM_PROVIDER ?? (e.OPENROUTER_API_KEY ? "openrouter" : "fake");
  if (opts.forceFake) llmProvider = "fake";

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
    approvalToken: e.APPROVAL_TOKEN ?? null,
    approvalTtlMin: e.APPROVAL_TTL_MIN,
    actionRateLimitPerMin: e.ACTION_RATE_LIMIT_PER_MIN,
    actionRepeatWindowMin: e.ACTION_REPEAT_WINDOW_MIN,
    circuitFailureThreshold: e.CIRCUIT_FAILURE_THRESHOLD,
    circuitCooldownSec: e.CIRCUIT_COOLDOWN_SEC,
    clock: e.CLOCK,
    logLevel: e.LOG_LEVEL,
  };
}
