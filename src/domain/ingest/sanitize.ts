// Hygiene for untrusted text (spec 008, decision 11; AC-50): every inbound or queried string passes here before it
// reaches the blackboard, the trace or a prompt. Pure.

/** Keeps untrusted text from opening or closing a delimited block (replaces <<< and >>> with angle quotes). */
export function neutralizeDelimiters(text: string): string {
  return text.replaceAll("<<<", "‹‹‹").replaceAll(">>>", "›››");
}

// C0 controls except \t (0x09) and \n (0x0a), DEL and C1 controls; zero-width and bidi override characters.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/**
 * Removes control characters (keeping newline and tab), collapses runs of whitespace (newline runs to one newline),
 * neutralizes the <<< and >>> delimiters and clips to `max` characters with an ellipsis.
 */
export function sanitizeText(s: string, max: number): string {
  let out = s.replace(/\r\n?/g, "\n").replace(CONTROL, "");
  out = out.replace(/[^\S\n]+/g, " ").replace(/ *\n[\s]*/g, "\n").trim();
  out = neutralizeDelimiters(out);
  return out.length <= max ? out : out.slice(0, Math.max(0, max - 1)) + "…";
}

export const MAX_ATTRIBUTES = 20;
const ATTRIBUTE_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;

/** At most 20 keys of up to 64 characters from [A-Za-z0-9_.:-]; string, number and boolean values, sanitized to 500. */
export function sanitizeAttributes(record: Readonly<Record<string, unknown>>): Record<string, string> {
  const entries: [string, string][] = [];
  for (const [k, v] of Object.entries(record)) {
    if (entries.length >= MAX_ATTRIBUTES) break;
    if (!ATTRIBUTE_KEY.test(k)) continue;
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") continue;
    entries.push([k, sanitizeText(String(v), 500)]);
  }
  return Object.fromEntries(entries);
}
