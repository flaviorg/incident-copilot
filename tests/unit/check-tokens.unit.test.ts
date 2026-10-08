// check:tokens (spec 4.8 e 10.2): cor literal fora de web/src/styles/tokens.css é erro.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findColorLiterals, scanTokens } from "../../scripts/check-tokens.ts";

test("finds literal colors", () => {
  assert.deepEqual(findColorLiterals("a{color:#fff;background:rgb(0,0,0)} b{color:var(--color-text)}"), ["#fff", "rgb("]);
  assert.deepEqual(findColorLiterals("#a1b2c3 #a1b2c3d4 hsl(1 2% 3%) hsla(1,2%,3%,.5) rgba(0,0,0,.1) #abcd"), ["#a1b2c3", "#a1b2c3d4", "hsl(", "hsla(", "rgba(", "#abcd"]);
  assert.deepEqual(findColorLiterals("color: var(--color-accent); #root { } url(#main)"), []);
});

test("the War Room sources have no literal color outside tokens.css", () => {
  assert.deepEqual(scanTokens(), []);
});
