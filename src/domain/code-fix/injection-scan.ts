// Injection markers over model output (spec 009, decision 21; AC-80). A heuristic floor: a hit makes the guards reject
// and `fix_finalize` give up. Isolation and human approval stay the real controls. Pure: no node imports.

export type InjectionMarker =
  | "ignore_instructions" | "role_claim" | "system_prompt" | "approve_request" | "delimiter_open" | "delimiter_close" | "as_an_ai";

export type InjectionScanResult = { hit: boolean; markers: InjectionMarker[] };

const PATTERNS: readonly (readonly [InjectionMarker, RegExp])[] = Object.freeze([
  ["ignore_instructions", /\bignore\s+(?:all\s+)?(?:previous|prior)\s+instructions\b/i],
  ["role_claim", /\byou\s+are\s+an?\s+(?:ai|assistant|language\s+model)\b/i],
  ["system_prompt", /\bsystem\s+prompt\b/i],
  ["approve_request", /\bapprove\s+this\s+(?:pr|pull\s+request)\b/i],
  ["delimiter_open", /<<</],
  ["delimiter_close", />>>/],
  ["as_an_ai", /\bas\s+an\s+ai\b/i],
] as const);

/** Zero-width and other invisible format characters that could split a marker without changing how it reads. */
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤﻿]/g;

/** Scans text for injection markers. The result names markers only; it never echoes the text. */
export function injectionScan(text: string): InjectionScanResult {
  const clean = typeof text === "string" ? text.replace(INVISIBLE, "") : "";
  const markers: InjectionMarker[] = [];
  for (const [marker, re] of PATTERNS) if (re.test(clean)) markers.push(marker);
  return { hit: markers.length > 0, markers };
}
