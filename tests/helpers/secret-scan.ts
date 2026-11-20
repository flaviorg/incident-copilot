// Secret scan over the output surfaces (spec 6.6; AC-17): literal occurrence of each secret in each text.
export function findSecretOccurrences(surfaces: { name: string; text: string }[], secrets: string[]): { surface: string; secret: string }[] {
  const found: { surface: string; secret: string }[] = [];
  for (const s of surfaces) {
    for (const secret of secrets) {
      if (secret.length > 0 && s.text.includes(secret)) found.push({ surface: s.name, secret: `${secret.slice(0, 4)}…(${secret.length} caracteres)` });
    }
  }
  return found;
}
