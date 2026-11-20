// X-Request-Id (spec 6.9): reuses the received one when it is short and only has [A-Za-z0-9._-]; otherwise generates a UUID.
// The restricted regex prevents log injection through the header (spec 6.10).
import { randomUUID } from "node:crypto";

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function requestIdFrom(headerValue: string | string[] | undefined): string {
  return typeof headerValue === "string" && VALID_REQUEST_ID.test(headerValue) ? headerValue : randomUUID();
}
