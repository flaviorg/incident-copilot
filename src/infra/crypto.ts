import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Compares in constant time over the SHA-256 of the two texts (same length), with no length shortcut (spec 6.6). */
export function constantTimeEqualsText(received: string, expected: string): boolean {
  const a = createHash("sha256").update(received, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** HMAC of raw bytes (webhook signatures, spec 008). The caller compares the digest in constant time. */
export function hmacDigest(algorithm: "sha256" | "sha1", secret: string, data: Buffer, encoding: "hex" | "base64"): string {
  return createHmac(algorithm, secret).update(data).digest(encoding);
}
