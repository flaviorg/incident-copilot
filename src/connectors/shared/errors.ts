// The only error a connector method throws (spec 008, architecture "Query capability"). The message is a fixed short
// text per kind: no body, header, URL or secret ever goes into it, so the registry can show it to the model.

export type ConnectorErrorKind = "auth" | "rate_limited" | "timeout" | "unavailable" | "bad_response" | "unsafe_input";

export const CONNECTOR_ERROR_TEXT: Record<ConnectorErrorKind, string> = {
  auth: "authentication failed",
  rate_limited: "rate limited by the provider",
  timeout: "timed out",
  unavailable: "unavailable",
  bad_response: "malformed response",
  unsafe_input: "unsafe input",
};

export class ConnectorError extends Error {
  readonly kind: ConnectorErrorKind;
  /** Seconds the provider asked to wait (rate_limited only), capped at 3600; otherwise null. */
  readonly retryAfterSec: number | null;
  constructor(kind: ConnectorErrorKind, o: { retryAfterSec?: number | null } = {}) {
    super(CONNECTOR_ERROR_TEXT[kind]);
    this.name = "ConnectorError";
    this.kind = kind;
    this.retryAfterSec = o.retryAfterSec ?? null;
  }
}
