// X-Request-Id (spec 6.9): reaproveita o recebido quando é curto e só tem [A-Za-z0-9._-]; senão gera um UUID.
// A regex restrita impede injeção em logs pelo cabeçalho (spec 6.10).
import { randomUUID } from "node:crypto";

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function requestIdFrom(headerValue: string | string[] | undefined): string {
  return typeof headerValue === "string" && VALID_REQUEST_ID.test(headerValue) ? headerValue : randomUUID();
}
