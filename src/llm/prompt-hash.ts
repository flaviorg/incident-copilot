// Hash do prompt registrado nas fixtures (spec 7.2, regra 1): só version + system; o schema de saída não entra.
import { sha256Hex } from "../infra/crypto.ts";

export function promptHash(p: { version: string; system: string }): string {
  return "sha256:" + sha256Hex(p.version + "\n" + p.system);
}
