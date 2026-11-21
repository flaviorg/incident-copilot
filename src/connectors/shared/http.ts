// HTTP client of the connectors and notifiers (spec 008, decision 13): plain fetch, injected so tests never touch the
// network. Redirects are refused, bodies are capped and every failure becomes a ConnectorError. Headers and bodies are
// never logged or embedded in an error.
import { APP_VERSION } from "../../infra/app-info.ts";
import { ConnectorError } from "./errors.ts";

export type HttpRequest = {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type HttpResponse = { status: number; headers: { get(name: string): string | null }; text: string };

export interface HttpClient {
  /** Never throws on status: timeout, network failure and an oversized body become ConnectorError. */
  request(r: HttpRequest): Promise<HttpResponse>;
  /** 401/403 auth, 429 rate_limited (Retry-After), 5xx unavailable, other non-2xx and invalid JSON bad_response. */
  json<T = unknown>(r: HttpRequest): Promise<T>;
}

export const MAX_RETRY_AFTER_SEC = 3600;

/** Retry-After in seconds or as an HTTP date, capped at 3600; null when absent or unreadable. */
export function parseRetryAfter(value: string | null, nowMs: number = Date.now()): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Math.min(MAX_RETRY_AFTER_SEC, Number(v));
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.min(MAX_RETRY_AFTER_SEC, Math.max(0, Math.ceil((at - nowMs) / 1000)));
}

async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new ConnectorError("bad_response");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new ConnectorError("bad_response");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createHttpClient(o: { fetch?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number; userAgent?: string } = {}): HttpClient {
  const doFetch = o.fetch ?? globalThis.fetch;
  const defaultTimeout = o.timeoutMs ?? 10_000;
  const maxBytes = o.maxResponseBytes ?? 1_048_576;
  const userAgent = o.userAgent ?? `incident-copilot/${APP_VERSION}`;

  const request = async (r: HttpRequest): Promise<HttpResponse> => {
    const timeout = AbortSignal.timeout(r.timeoutMs ?? defaultTimeout);
    const signal = r.signal ? AbortSignal.any([r.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await doFetch(r.url, {
        method: r.method,
        headers: { "user-agent": userAgent, ...r.headers },
        ...(r.body !== undefined ? { body: r.body } : {}),
        redirect: "error",
        signal,
      });
    } catch {
      throw new ConnectorError(signal.aborted ? "timeout" : "unavailable");
    }
    let text: string;
    try {
      text = await readCapped(res, maxBytes);
    } catch (e) {
      if (e instanceof ConnectorError) throw e;
      throw new ConnectorError(signal.aborted ? "timeout" : "unavailable");
    }
    return { status: res.status, headers: { get: (name) => res.headers.get(name) }, text };
  };

  return {
    request,
    async json<T>(r: HttpRequest): Promise<T> {
      const res = await request(r);
      if (res.status === 401 || res.status === 403) throw new ConnectorError("auth");
      if (res.status === 429) throw new ConnectorError("rate_limited", { retryAfterSec: parseRetryAfter(res.headers.get("retry-after")) });
      if (res.status >= 500) throw new ConnectorError("unavailable");
      if (res.status < 200 || res.status >= 300) throw new ConnectorError("bad_response");
      try {
        return JSON.parse(res.text) as T;
      } catch {
        throw new ConnectorError("bad_response");
      }
    },
  };
}
