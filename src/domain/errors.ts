// Erros tipados do domínio (spec 6.1). Cada um tem `code` estável; a borda (HTTP, MCP, CLI) traduz para status e texto curto.

export type Issue = { path: string; message: string };

/** Entrada inválida na borda ou arquivo de dados inválido. */
export class ValidationError extends Error {
  readonly code = "validation_error";
  readonly issues: Issue[];
  constructor(message: string, issues: Issue[] = []) {
    super(message);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export type NotFoundCode = "not_found" | "scenario_not_found";
export class NotFoundError extends Error {
  readonly code: NotFoundCode;
  constructor(code: NotFoundCode, message: string) {
    super(message);
    this.name = "NotFoundError";
    this.code = code;
  }
}

export type ConflictCode = "version_conflict" | "approval_not_pending" | "approval_expired" | "postmortem_not_ready" | "incident_not_accepting";
export class ConflictError extends Error {
  readonly code: ConflictCode;
  constructor(code: ConflictCode, message: string) {
    super(message);
    this.name = "ConflictError";
    this.code = code;
  }
}

/** 422: pedido bem formado que não pode ser processado (decisão ambígua, ação recusada pelo portão). */
export class UnprocessableError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "UnprocessableError";
    this.code = code;
  }
}

export class AuthError extends Error {
  readonly code = "invalid_token";
  constructor(message = "invalid or missing approval token") {
    super(message);
    this.name = "AuthError";
  }
}

export class LockedError extends Error {
  readonly code = "approvals_locked";
  constructor(message = "decisions temporarily locked after too many token attempts") {
    super(message);
    this.name = "LockedError";
  }
}

export class ApprovalsDisabledError extends Error {
  readonly code = "approvals_disabled";
  constructor(message = "approvals disabled: APPROVAL_TOKEN is not configured") {
    super(message);
    this.name = "ApprovalsDisabledError";
  }
}

export class LlmUnavailableError extends Error {
  readonly code = "llm_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

export class RunTimeoutError extends Error {
  readonly code = "run_timeout";
  constructor(message: string) {
    super(message);
    this.name = "RunTimeoutError";
  }
}

/** Chamada ao provedor fake sem turno roteirizado (spec 7.2, regra 3). Defeito do repositório, não do incidente. */
export class UnscriptedLlmCallError extends Error {
  readonly code = "unscripted_llm_call";
  readonly scenarioId: string;
  readonly prompt: string;
  readonly callNumber: number;
  readonly inputDigest: string;
  readonly matchKeys: Record<string, unknown>;
  readonly turnsTotal: number;
  readonly turnsConsumed: number;
  constructor(d: {
    scenarioId: string; prompt: string; callNumber: number; inputDigest: string;
    matchKeys: Record<string, unknown>; turnsTotal: number; turnsConsumed: number;
  }) {
    super(
      `LLM call without a scripted turn: scenario ${d.scenarioId}, prompt ${d.prompt}, call #${d.callNumber}, ` +
      `keys ${JSON.stringify(d.matchKeys)}, digest ${d.inputDigest}, turns of this prompt ${d.turnsConsumed}/${d.turnsTotal} consumed`,
    );
    this.name = "UnscriptedLlmCallError";
    this.scenarioId = d.scenarioId;
    this.prompt = d.prompt;
    this.callNumber = d.callNumber;
    this.inputDigest = d.inputDigest;
    this.matchKeys = d.matchKeys;
    this.turnsTotal = d.turnsTotal;
    this.turnsConsumed = d.turnsConsumed;
  }
}

/** Hash de `version + system` diferente do registrado na fixture (spec 7.2, regra 1). */
export class FixturePromptDriftError extends Error {
  readonly code = "fixture_prompt_drift";
  readonly prompt: string;
  readonly expected: string | null;
  readonly actual: string;
  constructor(d: { prompt: string; expected: string | null; actual: string }) {
    super(`prompt ${d.prompt} changed since the fixture (recorded ${d.expected ?? "missing"}, current ${d.actual}); run npm run fixtures:rehash and review the diff`);
    this.name = "FixturePromptDriftError";
    this.prompt = d.prompt;
    this.expected = d.expected;
    this.actual = d.actual;
  }
}

/** Valor devolvido (não lançado) pela máquina de aprovação quando a transição não é permitida. */
export class ApprovalTransitionError {
  readonly code: "not_pending" | "expired";
  constructor(code: "not_pending" | "expired") {
    this.code = code;
  }
}
