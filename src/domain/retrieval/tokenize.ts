// Lexical tokenization for BM25: lowercase, accents stripped, split on non-alphanumerics,
// drops short pt/en stopwords and tokens shorter than 2 characters. Pure.

const STOPWORDS = new Set([
  // pt
  "ao", "aos", "as", "com", "como", "da", "das", "de", "do", "dos", "em", "na", "nas", "no", "nos", "os", "ou",
  "para", "pela", "pelo", "por", "que", "se", "sem", "um", "uma", "uns", "umas", "mais", "foi", "ser", "sua", "seu",
  // en
  "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "with",
  "after", "all", "any", "been", "before", "but", "can", "each", "has", "have", "if", "into", "its", "no", "not", "only",
  "so", "than", "that", "there", "this", "was", "were", "when", "which", "who", "without",
]);

function stripAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "");
}

export function tokenize(text: string): string[] {
  return stripAccents(text.toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** Stable ASCII slug: "Mitigation" -> "mitigation", "Mitigação" -> "mitigacao", "Plan B" -> "plan-b". */
export function slugify(text: string): string {
  return stripAccents(text.toLowerCase()).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
