// The one static ban shared by the test guard and the patch guard (spec 009, decisions 7 and 10; AC-68, AC-70).
// In-process results can be forged by code that reaches the process object, so model-written code must not name it
// or any route to it. The rules work on the raw text, strings and comments included, so a lexer mistake can only make
// them stricter. Identifiers can be spelled with escapes, so every backslash-u or backslash-x sequence is rejected;
// a non-ASCII character is rejected outside string literals and comments. A heuristic floor: the permission model,
// `--disallow-code-generation-from-strings`, isolation and human approval are the real controls. Pure.

/** Banned identifiers, matched as whole words; computed access on them is covered by banning the name itself. */
export const BANNED_CODE_TOKENS: readonly (readonly [string, RegExp])[] = Object.freeze([
  ["process", /\bprocess\b/],
  ["console", /\bconsole\b/],
  ["globalThis", /\bglobalThis\b/],
  ["global", /\bglobal\b/],
  ["self", /\bself\b/],
  ["getBuiltinModule", /getBuiltinModule/],
  ["import(", /\bimport\s*\(/],
  ["require(", /\brequire\b/],
  ["eval", /\beval\b/],
  ["Function", /\bFunction\b/],
  ["Reflect", /\bReflect\b/],
] as const);

/** Fixed names of the non-identifier rules, as reported back to the author. */
export const ESCAPE_U = "\\u escape";
export const ESCAPE_X = "\\x escape";
export const NON_ASCII = "non-ASCII character in code";
export const COMPUTED_KEY = "computed key built from strings";

const ESCAPE_U_RE = /\\u/;
const ESCAPE_X_RE = /\\x/;

/** Every rule of the shared ban the text breaks, in a fixed order. */
export function codeBanHits(text: string): string[] {
  const hits: string[] = [];
  for (const [token, re] of BANNED_CODE_TOKENS) if (re.test(text)) hits.push(token);
  if (ESCAPE_U_RE.test(text)) hits.push(ESCAPE_U);
  if (ESCAPE_X_RE.test(text)) hits.push(ESCAPE_X);
  if (nonAsciiInCode(text)) hits.push(NON_ASCII);
  if (stringBuiltComputedKey(text)) hits.push(COMPUTED_KEY);
  return hits;
}

/**
 * True when a character above U+007F appears outside a string literal, a template's text or a comment. Regex literals
 * are not recognized; a quote inside one can only hide later code from this rule, and a non-ASCII character can never
 * spell a banned identifier, which the other rules match on the raw text.
 */
export function nonAsciiInCode(text: string): boolean {
  const templates: number[] = []; // brace depth at which each open `${` expression started
  let depth = 0;
  let i = 0;
  const n = text.length;
  // Scans template text from `i`; returns the index after the closing backtick or after a `${` (which opens code).
  const templateText = (from: number): number => {
    let j = from;
    while (j < n) {
      const c = text[j]!;
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "`") return j + 1;
      if (c === "$" && text[j + 1] === "{") {
        templates.push(depth);
        depth++;
        return j + 2;
      }
      j++;
    }
    return n;
  };
  while (i < n) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (c === "`") {
      i = templateText(i + 1);
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      if (templates.length > 0 && templates[templates.length - 1] === depth - 1) {
        templates.pop();
        depth--;
        i = templateText(i + 1);
        continue;
      }
      depth = Math.max(0, depth - 1);
    }
    if (text.charCodeAt(i) > 0x7f) return true;
    i++;
  }
  return false;
}

/** Words after which `[` opens an array literal, not a computed member access. */
const NOT_A_RECEIVER: ReadonlySet<string> = new Set([
  "return", "typeof", "in", "of", "case", "yield", "await", "else", "do", "void", "delete", "throw", "new", "instanceof",
  "export", "default", "extends",
]);
const MEMBER_OPEN = /([\w$]+|[)\]])\s*(?:\?\.\s*)?\[/g;
const SINGLE_LITERAL = /^\s*(?:"[^"\\\n]*"|'[^'\\\n]*'|`[^`\\$\n]*`)\s*$/;

/**
 * True when a computed member key contains a string, template or quote but is not one plain literal, as in
 * `x["con" + "structor"]` or `this[`pro${""}cess`]`. Keys made of plain literals, numbers or names are fine.
 */
export function stringBuiltComputedKey(text: string): boolean {
  for (const m of text.matchAll(MEMBER_OPEN)) {
    if (NOT_A_RECEIVER.has(m[1]!)) continue;
    const open = m.index! + m[0].length - 1;
    let nest = 0;
    let j = open + 1;
    for (; j < text.length && text[j] !== "\n"; j++) {
      const c = text[j]!;
      if (c === "[") nest++;
      else if (c === "]") {
        if (nest === 0) break;
        nest--;
      }
    }
    // An unclosed key runs to the end of the line.
    const key = text.slice(open + 1, j);
    if (/["'`]/.test(key) && !SINGLE_LITERAL.test(key)) return true;
  }
  return false;
}
