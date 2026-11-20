// Prompt hash recorded in the fixtures (spec 7.2, rule 1): only version + system; the output schema is not included.
import { sha256Hex } from "../infra/crypto.ts";

export function promptHash(p: { version: string; system: string }): string {
  return "sha256:" + sha256Hex(p.version + "\n" + p.system);
}
