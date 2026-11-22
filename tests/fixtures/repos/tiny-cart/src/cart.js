// Cart helpers for the tiny-cart fixture.

/** Price of one line: unit price times quantity, in cents. */
export function lineTotal(item) {
  return item.priceCents * item.quantity;
}

/**
 * Total of a cart in cents. A cart is `{ items: [{ priceCents, quantity }] }`.
 * Known bug, on purpose: a cart without `items` throws a TypeError on `cart.items.length`.
 */
export function cartTotal(cart) {
  let total = 0;
  for (let i = 0; i < cart.items.length; i++) {
    total += lineTotal(cart.items[i]);
  }
  return total;
}
