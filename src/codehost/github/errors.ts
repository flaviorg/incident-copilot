// The only error the GitHub code host throws (spec 009, decision 20; AC-78). The message is a fixed short text per kind:
// no body, header, URL or token ever goes into it.
import { ConnectorError } from "../../connectors/shared/errors.ts";
import { parseRetryAfter } from "../../connectors/shared/http.ts";
import type { CodeHostErrorKind, CodeHostErrorLike } from "../../domain/code-fix/ports.ts";

export type { CodeHostErrorKind };

export const CODEHOST_ERROR_TEXT: Record<CodeHostErrorKind, string> = {
  auth: "code host authentication failed",
  forbidden: "code host refused the request",
  not_found: "not found on the code host",
  conflict: "conflict on the code host",
  rate_limited: "rate limited by the code host",
  timeout: "code host timed out",
  unavailable: "code host unavailable",
  bad_response: "malformed code host response",
  unsafe_input: "unsafe code host input",
};

export class CodeHostError extends Error implements CodeHostErrorLike {
  override readonly name = "CodeHostError" as const;
  readonly kind: CodeHostErrorKind;
  /** HTTP status when the failure came from a response; null for transport and input failures. */
  readonly status: number | null;
  /** Seconds the code host asked to wait (rate_limited only), capped at 3600; otherwise null. */
  readonly retryAfterSec: number | null;
  constructor(kind: CodeHostErrorKind, o: { status?: number | null; retryAfterSec?: number | null } = {}) {
    super(CODEHOST_ERROR_TEXT[kind]);
    this.kind = kind;
    this.status = o.status ?? null;
    this.retryAfterSec = o.retryAfterSec ?? null;
  }
}

/**
 * Maps a non-2xx status to a fixed kind. A 403 with `x-ratelimit-remaining: 0` or a `retry-after` is GitHub's secondary
 * or primary rate limit (unverified, documented in docs/code-fixer.md), not a permission refusal.
 */
export function errorFromStatus(status: number, headers: { get(name: string): string | null }): CodeHostError {
  const retryAfterSec = parseRetryAfter(headers.get("retry-after"));
  if (status === 401) return new CodeHostError("auth", { status });
  if (status === 403) {
    const limited = headers.get("x-ratelimit-remaining")?.trim() === "0" || retryAfterSec !== null;
    return limited ? new CodeHostError("rate_limited", { status, retryAfterSec }) : new CodeHostError("forbidden", { status });
  }
  if (status === 404) return new CodeHostError("not_found", { status });
  if (status === 409 || status === 422) return new CodeHostError("conflict", { status });
  if (status === 429) return new CodeHostError("rate_limited", { status, retryAfterSec });
  if (status >= 500) return new CodeHostError("unavailable", { status });
  return new CodeHostError("bad_response", { status });
}

/** Transport failures from the shared HTTP client (timeout, network, oversized body) become fixed kinds. */
export function errorFromTransport(e: unknown): CodeHostError {
  if (e instanceof CodeHostError) return e;
  if (e instanceof ConnectorError) {
    if (e.kind === "timeout") return new CodeHostError("timeout");
    if (e.kind === "bad_response") return new CodeHostError("bad_response");
    if (e.kind === "unsafe_input") return new CodeHostError("unsafe_input");
  }
  return new CodeHostError("unavailable");
}
