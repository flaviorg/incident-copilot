// Utilitários dos prompts v1. O JSON do contexto sai do schema de entrada (campos desconhecidos são descartados),
// para o modelo receber só o que o tipo declara (200963).
import type * as z from "zod";

export function jsonOf<T>(schema: z.ZodType<T>, value: unknown): string {
  return JSON.stringify(schema.parse(value), null, 2);
}

/** Impede que um texto não confiável abra ou feche um bloco delimitado (troca <<< e >>> por aspas angulares). */
export function neutralizeDelimiters(text: string): string {
  return text.replaceAll("<<<", "‹‹‹").replaceAll(">>>", "›››");
}
