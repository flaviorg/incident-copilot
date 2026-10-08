import { createHash, timingSafeEqual } from "node:crypto";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Compara em tempo constante sobre os SHA-256 dos dois textos (mesmo tamanho), sem atalho por tamanho (spec 6.6). */
export function constantTimeEqualsText(received: string, expected: string): boolean {
  const a = createHash("sha256").update(received, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
