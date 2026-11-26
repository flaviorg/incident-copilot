import { test } from "node:test";
import assert from "node:assert/strict";
import { cartTotal, lineTotal } from "../src/cart.js";

test("lineTotal multiplies the unit price by the quantity", () => {
  assert.equal(lineTotal({ priceCents: 250, quantity: 3 }), 750);
});

test("cartTotal sums every line", () => {
  const cart = { items: [{ priceCents: 100, quantity: 2 }, { priceCents: 50, quantity: 1 }] };
  assert.equal(cartTotal(cart), 250);
});
