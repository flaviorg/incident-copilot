// Contraste WCAG 2.x entre duas cores hexadecimais e leitura de um token do tokens.css por tema (usado no teste de
// contraste, spec 8.2). Sem cor literal aqui: as cores vêm do tokens.css.

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function parseHex(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("");
  if (h.length === 8) h = h.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`cor hexadecimal inválida: ${hex}`);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Luminância relativa (WCAG 2.x). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Razão de contraste (L1 + 0,05) / (L2 + 0,05), com L1 a mais clara; a ordem dos argumentos não importa. */
export function contrastRatio(fgHex: string, bgHex: string): number {
  const [hi, lo] = [relativeLuminance(fgHex), relativeLuminance(bgHex)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const DARK_MARKER = "@media (prefers-color-scheme: dark)";

function find(block: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`${escaped}\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;`).exec(block);
  return m ? m[1]! : null;
}

/** Valor hexadecimal de um token no tema pedido; o escuro herda do claro o que não redefine (semântica do CSS). */
export function tokenHex(css: string, theme: "light" | "dark", name: string): string {
  const at = css.indexOf(DARK_MARKER);
  const light = at === -1 ? css : css.slice(0, at);
  const dark = at === -1 ? "" : css.slice(at);
  const value = (theme === "dark" ? find(dark, name) : null) ?? find(light, name);
  if (value === null) throw new Error(`token ${name} ausente no tema ${theme}`);
  return value;
}
