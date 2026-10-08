// Tokenização lexical para o BM25: minúsculas, sem acento, separa por não alfanumérico,
// remove stopwords curtas em pt/en e tokens com menos de 2 caracteres. Puro.

const STOPWORDS = new Set([
  // pt
  "ao", "aos", "as", "com", "como", "da", "das", "de", "do", "dos", "em", "na", "nas", "no", "nos", "os", "ou",
  "para", "pela", "pelo", "por", "que", "se", "sem", "um", "uma", "uns", "umas", "mais", "foi", "ser", "sua", "seu",
  // en
  "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "with",
]);

function stripAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "");
}

export function tokenize(text: string): string[] {
  return stripAccents(text.toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** Slug ASCII estável: "Mitigação" -> "mitigacao", "Plano B" -> "plano-b". */
export function slugify(text: string): string {
  return stripAccents(text.toLowerCase()).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
