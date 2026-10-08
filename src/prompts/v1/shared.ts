// Utilities for the v1 prompts. The context JSON comes from the input schema (unknown fields are dropped),
// so the model receives only what the type declares (200963).
import type * as z from "zod";

export function jsonOf<T>(schema: z.ZodType<T>, value: unknown): string {
  return JSON.stringify(schema.parse(value), null, 2);
}

/** Keeps untrusted text from opening or closing a delimited block (replaces <<< and >>> with angle quotes). */
export function neutralizeDelimiters(text: string): string {
  return text.replaceAll("<<<", "‹‹‹").replaceAll(">>>", "›››");
}
