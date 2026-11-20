// Free-text decision (spec 6.5, AC-13): only a whole phrase equal to a term in the lists counts. The LLM never takes part.
// Anything else is ambiguous and the edge answers 422 without changing state. Pure.

export const APPROVE_TERMS: readonly string[] = ["aprovar", "aprovo", "aprovado", "sim", "approve", "yes"];
export const REJECT_TERMS: readonly string[] = ["rejeitar", "rejeito", "rejeitado", "nao", "reject", "no"];

const EDGE_PUNCTUATION = /^[\p{P}\s]+|[\p{P}\s]+$/gu;

/** No accents (NFD without combining marks), lowercase, punctuation removed only at the ends, spaces collapsed. */
export function normalizeDecisionText(t: string): string {
  return t
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(EDGE_PUNCTUATION, "")
    .replace(/\s+/g, " ");
}

export function parseDecision(text: string): "approve" | "reject" | "ambiguous" {
  const n = normalizeDecisionText(text);
  if (APPROVE_TERMS.includes(n)) return "approve";
  if (REJECT_TERMS.includes(n)) return "reject";
  return "ambiguous";
}
