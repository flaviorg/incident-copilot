# tiny-cart

A test fixture for the incident copilot's code fixer (spec 009). It is not a real project.

`src/cart.js` has a deliberate bug: `cartTotal({})` throws a `TypeError` because it reads `cart.items.length`
when `items` is undefined. The tests in `tests/cart.test.js` pass; they do not cover that case.

The copilot's own test runs never pick these files up: its globs are `tests/unit/**/*.test.ts` and
`tests/e2e/**/*.test.ts`. `tests/helpers/fixture-repo.ts` copies this folder into a temporary Git repository.
