// Decisão em texto livre (spec 6.5, AC-13): só a frase inteira igual a um termo das listas vale. O LLM nunca participa.
// Qualquer outra coisa é ambígua e a borda responde 422 sem mudar estado. Puro.

export const APPROVE_TERMS: readonly string[] = ["aprovar", "aprovo", "aprovado", "sim", "approve", "yes"];
export const REJECT_TERMS: readonly string[] = ["rejeitar", "rejeito", "rejeitado", "nao", "reject", "no"];

const EDGE_PUNCTUATION = /^[\p{P}\s]+|[\p{P}\s]+$/gu;

/** Sem acentos (NFD sem marcas combinantes), minúsculas, pontuação removida só nas pontas, espaços colapsados. */
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
