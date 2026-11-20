// Fake HTTP transport for connector and notifier tests (spec 008): routes matched in order, every call recorded.
// An unmatched request rejects, so a test never reaches the network by accident (fetch is blocked anyway).

export type FakeRoute = {
  method?: string;
  url: string | RegExp;
  status?: number;
  /** An object is serialized as JSON with content-type application/json; a string is sent as is. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Waits before answering; honors the request's abort signal. */
  delayMs?: number;
  /** Simulates a network failure (fetch rejects with a TypeError). */
  error?: "network";
};

export type FakeCall = { method: string; url: string; headers: Record<string, string>; body: string | null };

function headersOf(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => (out[k] = v));
  return out;
}

const abortError = (signal: AbortSignal) => signal.reason ?? new DOMException("This operation was aborted", "AbortError");

export function createFakeFetch(routes: FakeRoute[]): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : init.body == null ? null : String(init.body);
    calls.push({ method, url, headers: headersOf(init.headers), body });
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw abortError(signal);
    const route = routes.find((r) => (r.method === undefined || r.method.toUpperCase() === method) && (typeof r.url === "string" ? r.url === url : r.url.test(url)));
    if (!route) throw new Error(`unexpected request: ${method} ${url}`);
    if (route.delayMs !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, route.delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(abortError(signal));
        }, { once: true });
      });
    }
    if (route.error === "network") throw new TypeError("fetch failed");
    const headers = new Headers(route.headers);
    let text = "";
    if (typeof route.body === "string") text = route.body;
    else if (route.body !== undefined) {
      text = JSON.stringify(route.body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
    return new Response(text === "" && (route.status === 204 || route.status === 304) ? null : text, { status: route.status ?? 200, headers });
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}
