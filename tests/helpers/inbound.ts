// InboundRequest builder for connector tests, with the defaults the /ingest route would produce.
import type { InboundRequest } from "../../src/connectors/types.ts";

export type InboundOptions = {
  connectorId?: string;
  requestId?: string;
  receivedAt?: Date;
  headers?: Record<string, string>;
  /** A string, an object (serialized as JSON) or exact bytes. */
  body?: string | Buffer | unknown;
  pathToken?: string | null;
  remoteAddress?: string;
};

export const INBOUND_RECEIVED_AT = new Date("2026-10-04T10:00:00.000Z");

export function inboundRequest(o: InboundOptions = {}): InboundRequest {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.headers ?? {})) headers[k.toLowerCase()] = v;
  const body = o.body;
  const rawBody = Buffer.isBuffer(body) ? body : typeof body === "string" ? Buffer.from(body, "utf8") : body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
  if (!("content-type" in headers) && rawBody.length > 0) headers["content-type"] = "application/json";
  return {
    connectorId: o.connectorId ?? "test",
    requestId: o.requestId ?? "req-test",
    receivedAt: o.receivedAt ?? INBOUND_RECEIVED_AT,
    headers,
    rawBody,
    pathToken: o.pathToken ?? null,
    remoteAddress: o.remoteAddress ?? "127.0.0.1",
  };
}

/** The same request with extra or replaced headers (names lower-cased). */
export function withHeaders(req: InboundRequest, headers: Record<string, string>): InboundRequest {
  const next: Record<string, string> = { ...req.headers };
  for (const [k, v] of Object.entries(headers)) next[k.toLowerCase()] = v;
  return { ...req, headers: next };
}
