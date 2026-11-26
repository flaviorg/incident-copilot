// The string the patch hash is computed over (spec 009, decision 15). Pure: the SHA-256 itself is computed in app or
// infra (node:crypto) over the output of `canonicalPatchPayload`, and must equal the attempt's and the approval's hash.
import { canonicalJson } from "../canonical-json.ts";

/** Canonical JSON of `{ patch, files: [{ path, afterSha256 }] }`, paths sorted by UTF-16 code unit, extra fields dropped. */
export function canonicalPatchPayload(
  patch: string,
  files: readonly { path: string; afterSha256: string }[],
): string {
  const sorted = files
    .map((f) => ({ path: f.path, afterSha256: f.afterSha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return canonicalJson({ patch, files: sorted });
}
