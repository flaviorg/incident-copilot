# AGENTS.md

Conventions for contributors to tiny-cart.

- Tests use `node:test` and `node:assert/strict`, one file per module, in `tests/<module>.test.js`.
- Import the module under test with a relative path, for example `../src/cart.js`.
- Keep changes small. Prices are integers in cents.
- Run the suite with `npm test`.
