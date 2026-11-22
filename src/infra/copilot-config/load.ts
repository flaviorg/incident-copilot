// copilot.yaml loader (spec 008; AC-51, AC-52 and AC-55): YAML (yaml@2.8.1, core schema, unique keys, default alias cap)
// or JSON, then zod. Every problem is { path, rule } with a fixed rule: never zod's own text and never a value.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import YAML from "yaml";
import type * as z from "zod";
import type { Config } from "../../config.ts";
import { CopilotConfigError } from "../../domain/errors.ts";
import { createConfigHelpers } from "../../connectors/shared/config-helpers.ts";
import type { ConnectorDefinition } from "../../connectors/types.ts";
import type { NotifierDefinition } from "../../notifiers/types.ts";
import {
  CONNECTOR_BASE_KEYS, ConnectorBaseSchema, NOTIFIER_BASE_KEYS, NotifierBaseSchema, topLevelSchema,
} from "./schema.ts";
import type { CodeFixConfig, ConnectorEntry, CopilotConfig, NotifierEntry } from "./schema.ts";

export type { CopilotConfig, ConnectorEntry, NotifierEntry, IngestSettings, CodeFixConfig, CodeFixRepository } from "./schema.ts";

export type ConfigProblem = { path: string; rule: string };
export type CopilotConfigResult = { ok: true; config: CopilotConfig } | { ok: false; problems: ConfigProblem[] };
export type CopilotConfigOptions = {
  format: "yaml" | "json";
  env: Readonly<Record<string, string | undefined>>;
  connectors: readonly ConnectorDefinition<unknown>[];
  notifiers: readonly NotifierDefinition<unknown>[];
};

type PathPart = PropertyKey;

/** "connectors[0].ingest.auth.token": numbers as [n], keys after a dot. */
export function formatPath(parts: readonly PathPart[]): string {
  let out = "";
  for (const p of parts) {
    if (typeof p === "number") out += `[${p}]`;
    else out += out === "" ? String(p) : `.${String(p)}`;
  }
  return out;
}

const clipKey = (k: string) => (k.length <= 64 ? k : k.slice(0, 63) + "…").replace(/[^\x20-\x7e]/g, "?");

/** zod issue → fixed rules (one per unknown key). */
function rulesOf(issue: z.core.$ZodIssue, prefix: readonly PathPart[]): ConfigProblem[] {
  const path = formatPath([...prefix, ...issue.path]);
  switch (issue.code) {
    case "invalid_type":
      return [{ path, rule: `must be ${issue.expected}` }];
    case "too_small":
    case "too_big":
      return [{ path, rule: "out of range" }];
    case "invalid_value":
      return [{ path, rule: `must be one of: ${issue.values.map((v) => String(v)).join(", ")}` }];
    case "unrecognized_keys":
      return issue.keys.map((k) => ({ path, rule: `unknown key ${clipKey(k)}` }));
    case "custom":
      return [{ path, rule: issue.message }];
    case "invalid_format":
      return [{ path, rule: "invalid format" }];
    case "invalid_union":
      return [{ path, rule: "not one of the allowed variants" }];
    default:
      return [{ path, rule: "invalid value" }];
  }
}

function issuesToProblems(issues: readonly z.core.$ZodIssue[], prefix: readonly PathPart[]): ConfigProblem[] {
  return issues.flatMap((i) => rulesOf(i, prefix));
}

function parseText(text: string, format: "yaml" | "json"): { ok: true; value: unknown } | { ok: false; problems: ConfigProblem[] } {
  if (format === "json") {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false, problems: [{ path: "", rule: "invalid JSON" }] };
    }
  }
  const doc = YAML.parseDocument(text, { prettyErrors: true, uniqueKeys: true, schema: "core", logLevel: "silent" });
  const first = doc.errors[0];
  if (first) return { ok: false, problems: [{ path: first.linePos ? `line ${first.linePos[0].line}` : "", rule: "invalid YAML" }] };
  try {
    return { ok: true, value: doc.toJS({ maxAliasCount: 100 }) };
  } catch {
    return { ok: false, problems: [{ path: "", rule: "invalid YAML" }] };
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function split(entry: Record<string, unknown>, keys: readonly string[]): { base: Record<string, unknown>; rest: Record<string, unknown> } {
  const base: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) (keys.includes(k) ? base : rest)[k] = v;
  return { base, rest };
}

export function parseCopilotConfig(text: string, o: CopilotConfigOptions): CopilotConfigResult {
  const parsed = parseText(text, o.format);
  if (!parsed.ok) return parsed;
  if (!isRecord(parsed.value)) return { ok: false, problems: [{ path: "", rule: "must be object" }] };

  const secrets: string[] = [];
  const h = createConfigHelpers(o.env, secrets);
  const problems: ConfigProblem[] = [];
  const top = topLevelSchema(h).safeParse(parsed.value);
  if (!top.success) return { ok: false, problems: issuesToProblems(top.error.issues, []) };

  const knownConnectors = o.connectors.map((d) => d.type);
  const connectors: ConnectorEntry[] = [];
  const seenIds = new Set<string>();
  top.data.connectors.forEach((raw, i) => {
    const at = ["connectors", i] as const;
    if (!isRecord(raw)) return void problems.push({ path: formatPath(at), rule: "must be object" });
    const { base, rest } = split(raw, CONNECTOR_BASE_KEYS);
    const b = ConnectorBaseSchema.safeParse(base);
    if (!b.success) return void problems.push(...issuesToProblems(b.error.issues, at));
    if (seenIds.has(b.data.id)) return void problems.push({ path: formatPath([...at, "id"]), rule: "duplicate connector id" });
    seenIds.add(b.data.id);
    const def = o.connectors.find((d) => d.type === b.data.type);
    if (!def) {
      return void problems.push({ path: formatPath([...at, "type"]), rule: `unknown connector type; known: ${knownConnectors.join(", ") || "none"}` });
    }
    const c = def.configSchema(h).safeParse(rest);
    if (!c.success) return void problems.push(...issuesToProblems(c.error.issues, at));
    connectors.push({ ...b.data, capabilities: [...def.capabilities], config: c.data });
  });

  const knownNotifiers = o.notifiers.map((d) => d.type);
  const notifiers: NotifierEntry[] = [];
  const seenNotifiers = new Set<string>();
  top.data.notifiers.forEach((raw, i) => {
    const at = ["notifiers", i] as const;
    if (!isRecord(raw)) return void problems.push({ path: formatPath(at), rule: "must be object" });
    const { base, rest } = split(raw, NOTIFIER_BASE_KEYS);
    const b = NotifierBaseSchema.safeParse(base);
    const def = typeof base.type === "string" ? o.notifiers.find((d) => d.type === base.type) : undefined;
    if (typeof base.type === "string" && !def) {
      problems.push({ path: formatPath([...at, "type"]), rule: `unknown notifier type; known: ${knownNotifiers.join(", ") || "none"}` });
    }
    if (!b.success) return void problems.push(...issuesToProblems(b.error.issues, at));
    if (!def) return;
    if (seenNotifiers.has(b.data.id)) return void problems.push({ path: formatPath([...at, "id"]), rule: "duplicate notifier id" });
    seenNotifiers.add(b.data.id);
    const c = def.configSchema(h).safeParse(rest);
    if (!c.success) return void problems.push(...issuesToProblems(c.error.issues, at));
    notifiers.push({ ...b.data, config: c.data });
  });

  const seenServices = new Set<string>();
  top.data.services.forEach((s, i) => {
    if (seenServices.has(s.name)) problems.push({ path: formatPath(["services", i, "name"]), rule: "duplicate service name" });
    seenServices.add(s.name);
    for (const key of Object.keys(s.aliases)) {
      if (!seenIds.has(key)) problems.push({ path: formatPath(["services", i, "aliases", clipKey(key)]), rule: "alias keys must be connector ids" });
    }
  });

  const codeFix = top.data.codeFix ?? null;
  if (codeFix !== null) problems.push(...codeFixProblems(codeFix, seenServices, connectors));

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      version: 1,
      mode: "shadow",
      publicUrl: top.data.publicUrl,
      ingest: top.data.ingest,
      services: top.data.services,
      connectors,
      notifiers,
      codeFix,
      secrets: [...new Set(secrets)],
    },
  };
}

/** Spec 009 cross-checks (AC-84). Fixed rules only: never a value. */
function codeFixProblems(codeFix: CodeFixConfig, services: ReadonlySet<string>, connectors: readonly ConnectorEntry[]): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const usedServices = new Set<string>();
  const usedRepos = new Set<string>();
  codeFix.repositories.forEach((r, i) => {
    const at = (key: string) => formatPath(["codeFix", "repositories", i, key]);
    if (!services.has(r.service)) out.push({ path: at("service"), rule: "unknown service; must be a services[].name" });
    else if (usedServices.has(r.service)) out.push({ path: at("service"), rule: "duplicate service; one repository per service" });
    usedServices.add(r.service);
    const connector = connectors.find((c) => c.id === r.connector);
    if (!connector) out.push({ path: at("connector"), rule: "unknown connector id" });
    else if (connector.type !== "sentry") out.push({ path: at("connector"), rule: "must be a connector of type sentry" });
    // GitHub owner and repository names are case-insensitive.
    const key = r.repo.toLowerCase();
    if (usedRepos.has(key)) out.push({ path: at("repo"), rule: "duplicate repository" });
    usedRepos.add(key);
  });
  if (codeFix.mode === "draft_pr" && codeFix.github.token === null) {
    out.push({ path: "codeFix.github.token", rule: "required when mode is draft_pr" });
  }
  return out;
}

export function loadCopilotConfigFile(path: string, o: Omit<CopilotConfigOptions, "format">): CopilotConfigResult {
  const ext = extname(path).toLowerCase();
  const format = ext === ".yaml" || ext === ".yml" ? "yaml" : ext === ".json" ? "json" : null;
  if (format === null) return { ok: false, problems: [{ path: "", rule: "the config file must end in .yaml, .yml or .json" }] };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, problems: [{ path: "", rule: "cannot read the config file" }] };
  }
  return parseCopilotConfig(text, { ...o, format });
}

/**
 * npm start only. AC-55: the fake provider replays scripts, so it must never answer a real alert. Spec 009, decision 19:
 * a draft_pr code fixer needs APPROVAL_TOKEN (a human approves every pull request) and the GitHub token, with any provider.
 */
export function assertLiveSafe(config: Pick<Config, "llmProvider" | "approvalToken">, copilot: CopilotConfig | null): void {
  if (copilot === null) return;
  const fix = copilot.codeFix;
  if (fix && fix.enabled && fix.mode === "draft_pr") {
    const problems: { path: string; rule: string }[] = [];
    if (config.approvalToken === null || config.approvalToken === "") {
      problems.push({ path: "codeFix.mode", rule: "draft_pr requires APPROVAL_TOKEN; a human approves every pull request" });
    }
    if (fix.github.token === null) problems.push({ path: "codeFix.github.token", rule: "required when mode is draft_pr" });
    if (problems.length > 0) throw new CopilotConfigError(problems);
  }
  if (config.llmProvider !== "fake") return;
  // The entry decides, not its definition: a Sentry entry with only `query` receives nothing and is safe with the fake.
  const hasIngest = (c: CopilotConfig["connectors"][number]) => isRecord(c.config) && c.config.ingest !== undefined && c.config.ingest !== null;
  if (copilot.connectors.some((c) => c.enabled && c.capabilities.includes("ingest") && hasIngest(c))) {
    throw new CopilotConfigError([{ path: "connectors", rule: "ingest connectors require LLM_PROVIDER=openrouter; the fake provider only replays scripts" }]);
  }
}
