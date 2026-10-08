// Contraste dos pares de cor declarados (spec 8.2; AC-39): pelo menos 4,5:1 nos temas claro e escuro.
import { describe, expect, it } from "vitest";
import css from "../styles/tokens.css?raw";
import pairs from "../styles/contrast-pairs.json";
import { contrastRatio, tokenHex } from "../styles/contrast.ts";

describe("design tokens", () => {
  it("every declared pair reaches 4.5:1 in light and dark themes", () => {
    expect(pairs.length).toBeGreaterThanOrEqual(10);
    for (const theme of ["light", "dark"] as const) {
      for (const [fg, bg] of pairs as [string, string][]) {
        const ratio = contrastRatio(tokenHex(css, theme, fg), tokenHex(css, theme, bg));
        expect(ratio, `${theme}: ${fg} sobre ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("contrastRatio matches known values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#ffffff", "#777777")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#fff", "#000")).toBeCloseTo(21, 1);
  });

  it("tokenHex reads each theme and fails loudly for a missing token", () => {
    expect(tokenHex(css, "light", "--color-bg")).toMatch(/^#[0-9a-f]{6}$/i);
    expect(tokenHex(css, "dark", "--color-bg")).not.toBe(tokenHex(css, "light", "--color-bg"));
    expect(() => tokenHex(css, "light", "--color-nope")).toThrow(/--color-nope/);
  });
});
